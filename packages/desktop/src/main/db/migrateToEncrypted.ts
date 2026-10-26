import { env } from '../testHooks'
import { closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { BLOB_DATA_TABLE } from '../blobs'
import { readJsonCappedSync } from '../vault/atomic'
import { toHex, vaultNative } from '../vault/native'
import type { KeyHandle } from '@slate/native'
import { openDatabase, type Database } from './openDatabase'

/** §7.4 steps 2–4; a crash can be injected before each (`SLATE_TEST_CRASH_AT=<step>`). */
export const MIGRATION_STEPS = ['checkpoint', 'copy', 'blobs', 'rekey', 'verify', 'wal', 'rename'] as const
export type MigrationStep = (typeof MIGRATION_STEPS)[number]

export class OtherProgramHasNotesOpen extends Error {
  constructor() {
    super("Another program has your notes open (for example an AI agent's slate-mcp). Close it and try again.")
    this.name = 'OtherProgramHasNotesOpen'
  }
}

export class MigrationVerifyFailed extends Error {
  constructor(detail: string) {
    super(`The encrypted copy did not match your notes: ${detail}`)
    this.name = 'MigrationVerifyFailed'
  }
}

const BLOB_NAME = /^([a-f0-9]{64})\.[a-z0-9]{1,5}$/
const DOC_ID = /^(notebook|page):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function crashPoint(step: MigrationStep): void {
  const testing = env('SLATE_E2E') === '1' || env('VITEST') !== undefined
  if (testing && env('SLATE_TEST_CRASH_AT') === step) throw new Error(`Injected crash before ${step}`)
}

function isBusy(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? ''
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')
}

/** Makes this connection the only one that can use the plaintext database until it is closed (§15 N3). */
export function holdExclusive(file: string): Database.Database {
  let db: Database.Database
  try {
    db = openDatabase(file, null)
  } catch (err) {
    if (isBusy(err)) throw new OtherProgramHasNotesOpen()
    throw err
  }
  try {
    db.pragma('busy_timeout = 0')
    db.pragma('locking_mode = EXCLUSIVE')
    db.exec('BEGIN IMMEDIATE')
    db.exec('COMMIT')
    return db
  } catch (err) {
    db.close()
    if (isBusy(err)) throw new OtherProgramHasNotesOpen()
    throw err
  }
}

function userTables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name,
  )
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g, '""')}"`).get() as { n: number }).n
}

/**
 * Zeroes a file in place before unlinking it (review N2): the temp copy holds the notes and images in
 * plaintext, and an unlinked file's blocks would otherwise keep them until reused. Best effort: an SSD
 * or a copy-on-write file system may still keep old blocks; cleanupPlaintext treats slate.db the same.
 * Only the file itself: a symlink planted at a temp name is never followed (O_NOFOLLOW), and anything
 * but a regular file is left alone, so the scrub can never zero some other file.
 */
function scrub(file: string): void {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW)
  } catch {
    return
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return
    const size = stat.size
    const zeros = Buffer.alloc(Math.min(size, 1 << 20))
    for (let at = 0; at < size; at += zeros.length) writeSync(fd, zeros, 0, Math.min(zeros.length, size - at), at)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function removeTemp(tmp: string): void {
  for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) {
    scrub(f)
    rmSync(f, { force: true })
  }
}

/**
 * SQLCipher cannot encrypt a plaintext file in place (rekey on an unkeyed database is SQLITE_MISUSE),
 * so the plaintext copy is exported into a new file keyed from the handle. The module does the ATTACH
 * and sqlcipher_export itself (importPlaintextDatabase); SQL text may do neither (review M1).
 */
function exportEncrypted(plainFile: string, encFile: string, key: KeyHandle): void {
  const out = openDatabase(encFile, key, { wal: false })
  try {
    out.importPlaintextDatabase(plainFile)
  } finally {
    out.close()
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Inserts every image whose bytes hash to its name; returns the names left out. */
function insertImages(db: Database.Database, blobsDir: string): { images: number; skipped: string[] } {
  db.exec(BLOB_DATA_TABLE)
  const insert = db.prepare('INSERT OR REPLACE INTO blob_data (name, mime, data) VALUES (?, ?, ?)')
  const mimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }
  const skipped: string[] = []
  let images = 0
  let names: string[] = []
  try {
    names = readdirSync(blobsDir).filter((n) => BLOB_NAME.test(n)).sort()
  } catch {
    // No images folder: nothing to move.
  }
  db.transaction(() => {
    for (const name of names) {
      let data: Buffer
      try {
        data = readFileSync(join(blobsDir, name))
      } catch {
        skipped.push(name)
        continue
      }
      if (toHex(vaultNative().sha256(data)) !== BLOB_NAME.exec(name)![1]) {
        skipped.push(name)
        continue
      }
      insert.run(name, mimes[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream', data)
      images++
    }
  })()
  return { images, skipped }
}

function verify(copy: Database.Database, plain: Database.Database, images: number): void {
  const integrity = copy.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') throw new MigrationVerifyFailed(`integrity check: ${String(integrity)}`)
  for (const table of userTables(plain)) {
    const [want, got] = [rowCount(plain, table), rowCount(copy, table)]
    if (want !== got) throw new MigrationVerifyFailed(`${table} has ${got} rows, expected ${want}`)
  }
  const docIds = (copy.prepare('SELECT doc_id FROM snapshots UNION SELECT doc_id FROM updates').all() as Array<{ doc_id: string }>).map((r) => r.doc_id)
  const snapshot = copy.prepare('SELECT data FROM snapshots WHERE doc_id = ?')
  const updates = copy.prepare('SELECT data FROM updates WHERE doc_id = ? ORDER BY id')
  for (const docId of docIds) {
    const doc = new LoroDoc()
    const parts = [...(snapshot.all(docId) as Array<{ data: Buffer }>), ...(updates.all(docId) as Array<{ data: Buffer }>)]
    try {
      for (const part of parts) doc.import(new Uint8Array(part.data))
    } catch (err) {
      throw new MigrationVerifyFailed(`${docId} does not load (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  const stored = rowCount(copy, 'blob_data')
  if (stored !== images) throw new MigrationVerifyFailed(`${stored} images stored, expected ${images}`)
}

export interface CopyAndEncryptOptions {
  plainFile: string
  outFile: string
  /** The module key handle for the encrypted copy; the caller owns (and destroys) it. */
  key: KeyHandle
  blobsDir: string
  /** The caller's `holdExclusive` connection; without one, this holds the file itself for the copy. */
  held?: Database.Database
  /** Test seam: runs after each step with the temp copy's path. */
  afterStep?: (step: MigrationStep, tmp: string) => void
}

/**
 * Writes an encrypted copy of the plaintext database (with the images inside) to `outFile`.
 * Re-runnable: a previous attempt's temp copy is discarded. The plaintext database is only read.
 */
export function copyAndEncrypt(opts: CopyAndEncryptOptions): { images: number; skipped: string[] } {
  const { plainFile, outFile, key, blobsDir } = opts
  const tmp = `${outFile}.tmp`
  const enc = `${outFile}.enc.tmp`
  if (existsSync(outFile)) throw new Error(`${basename(outFile)} already exists; Slate will not overwrite an encrypted database`)
  const held = opts.held ?? holdExclusive(plainFile)
  const step = (name: MigrationStep, run: () => void): void => {
    crashPoint(name)
    run()
    opts.afterStep?.(name, tmp)
  }
  let copy: Database.Database | undefined
  try {
    removeTemp(tmp)
    removeTemp(enc)
    let report = { images: 0, skipped: [] as string[] }
    step('checkpoint', () => held.pragma('wal_checkpoint(TRUNCATE)'))
    step('copy', () => copyFileSync(plainFile, tmp))
    step('blobs', () => {
      copy = openDatabase(tmp, null, { wal: false })
      // A rollback journal: the export attaches this file, and nothing may wait in a -wal beside it.
      copy.pragma('journal_mode = DELETE')
      report = insertImages(copy, blobsDir)
    })
    step('rekey', () => {
      copy!.close()
      copy = undefined
      exportEncrypted(tmp, enc, key)
      removeTemp(tmp)
      renameSync(enc, tmp)
    })
    step('verify', () => {
      copy = openDatabase(tmp, key, { wal: false })
      verify(copy, held, report.images)
    })
    step('wal', () => {
      copy!.pragma('journal_mode = WAL')
      copy!.close()
      copy = undefined
    })
    step('rename', () => {
      fsyncPath(tmp)
      renameSync(tmp, outFile)
      fsyncPath(dirname(outFile))
    })
    return report
  } catch (err) {
    copy?.close()
    removeTemp(tmp)
    removeTemp(enc)
    throw err
  } finally {
    if (!opts.held) held.close()
  }
}

/**
 * An encrypted database re-encrypted under a new key, as a new file (§7.5 rejoin since C5): a database key
 * never moves to another KEK (review C4 M1-R), so a device joining another vault gets a fresh LK and its notes
 * are copied and rekeyed. `fromFile` is only read; `outFile` appears only once its copy is complete and opens
 * under `toKey`. The caller owns both handles; nothing else may have `fromFile` open.
 */
export function copyAndRekey(opts: { fromFile: string; fromKey: KeyHandle; outFile: string; toKey: KeyHandle }): void {
  const { fromFile, fromKey, outFile, toKey } = opts
  const tmp = `${outFile}.tmp`
  if (existsSync(outFile)) throw new Error(`${basename(outFile)} already exists; Slate will not overwrite an encrypted database`)
  let db: Database.Database | undefined
  try {
    removeTemp(tmp)
    db = openDatabase(fromFile, fromKey, { wal: false })
    db.pragma('wal_checkpoint(TRUNCATE)')
    const want = rowCounts(db)
    db.close()
    db = undefined
    copyFileSync(fromFile, tmp)
    db = openDatabase(tmp, fromKey, { wal: false })
    // A rollback journal: the rekey rewrites every page, and nothing may wait in a -wal beside the copy.
    db.pragma('journal_mode = DELETE')
    db.rekeyWithHandle(toKey)
    db.close()
    db = undefined
    db = openDatabase(tmp, toKey, { wal: false })
    // Review C9 C1: the copy counts only once it opens under the new key with every row of the original.
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('The re-encrypted copy of your notes failed its integrity check; nothing was changed')
    const got = rowCounts(db)
    if (got.updates !== want.updates || got.snapshots !== want.snapshots) throw new Error('The re-encrypted copy of your notes is incomplete; nothing was changed')
    db.pragma('journal_mode = WAL')
    db.close()
    db = undefined
    fsyncPath(tmp)
    renameSync(tmp, outFile)
    fsyncPath(dirname(outFile))
  } catch (err) {
    db?.close()
    removeTemp(tmp)
    throw err
  }
}

/** The note rows a copy must carry over (the snapshots and the updates of every doc). */
function rowCounts(db: Database.Database): { updates: number; snapshots: number } {
  const updates = (db.prepare('SELECT count(*) AS n FROM updates').get() as { n: number }).n
  const snapshots = (db.prepare('SELECT count(*) AS n FROM snapshots').get() as { n: number }).n
  return { updates, snapshots }
}

/** Doc ids that are not `notebook:<uuidv4>` / `page:<uuidv4>`; encrypted remote names need that shape (§15 N1). */
export function verifyDocIds(db: Database.Database): string[] {
  const rows = db.prepare('SELECT doc_id FROM snapshots UNION SELECT doc_id FROM updates').all() as Array<{ doc_id: string }>
  return rows.map((r) => r.doc_id).filter((id) => !DOC_ID.test(id))
}

/**
 * The database `local-keys.json` names (its `db` field is not secret); undefined without the file,
 * null when the file is there but unreadable (oversized, not a file, not JSON): then nobody can
 * tell which database is live.
 */
/**
 * The live database as local-keys.json names it: undefined when there is none, null when unknown. A v2 file
 * authenticates its `db`, but only under MK, which a locked device does not have: its name counts only when the
 * caller passes it verified (readLocalKeys), so a repointed `db` can never mark the real database as a stray
 * (review C1, F-GEN-01). A v1 file is trusted as it is (header-v1 vaults are untouched until C9).
 */
function currentDb(dataDir: string, verified?: string): string | undefined | null {
  const file = join(dataDir, 'local-keys.json')
  if (!existsSync(file)) return undefined
  try {
    const { db, version } = readJsonCappedSync(file) as { db?: unknown; version?: unknown }
    if (typeof db !== 'string') return null
    if (version !== 2) return db
    return verified !== undefined && verified === db ? db : null
  } catch {
    return null
  }
}

/**
 * Removes every `slate-*.db*` that `local-keys.json` does not name, and every temp copy, scrubbed. A
 * copy interrupted before its rekey is plaintext; any other is unreadable here (its key was never kept).
 * With `local-keys.json` unreadable the live database is unknown, so only the temp copies go: they are
 * never the live database, and one may be a plaintext copy of the notes (C1 re-review).
 */
export function removeStrayDatabases(dataDir: string, verifiedDb?: string): number {
  const keep = currentDb(dataDir, verifiedDb)
  let files: string[]
  try {
    files = readdirSync(dataDir)
  } catch {
    return 0
  }
  // Each stray on its own (review C5): one that cannot be removed must not leave a plaintext temp copy after it.
  let failed = 0
  for (const f of files) {
    if (!/^slate-.*\.db/.test(f)) continue
    const temp = f.includes('.tmp')
    // Removing "strays" without knowing the live database could delete it.
    if (!temp && (keep === null || (keep && (f === keep || f.startsWith(`${keep}-`))))) continue
    try {
      if (temp) scrub(join(dataDir, f))
      rmSync(join(dataDir, f), { force: true })
    } catch {
      failed++
    }
  }
  return failed
}

/** §7.4 step 6: unlinks every plaintext copy of the notes once the encrypted database is authoritative. */
export function cleanupPlaintext(dataDir: string, tempDir: string = tmpdir()): void {
  for (const f of ['slate.db', 'slate.db-wal', 'slate.db-shm']) rmSync(join(dataDir, f), { force: true })
  for (const d of ['blobs', 'Cache', 'Code Cache']) rmSync(join(dataDir, d), { recursive: true, force: true })
  removeStrayDatabases(dataDir)
  let entries: string[] = []
  try {
    entries = readdirSync(tempDir)
  } catch {
    return
  }
  // The OneNote importer's converter output (onenote/backup.ts).
  for (const e of entries) if (e.startsWith('slate-one2html-')) rmSync(join(tempDir, e), { recursive: true, force: true })
}
