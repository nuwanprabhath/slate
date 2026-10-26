import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { DbBlobStore } from '../blobs'
import { DocStore } from '../store'
import { openDatabase, WrongKey } from './openDatabase'
import {
  cleanupPlaintext,
  copyAndEncrypt,
  holdExclusive,
  MIGRATION_STEPS,
  MigrationVerifyFailed,
  OtherProgramHasNotesOpen,
  removeStrayDatabases,
  verifyDocIds,
} from './migrateToEncrypted'
import { testKey } from './testModule'

let dir: string
let plainFile: string
let outFile: string
let blobsDir: string
const key = testKey()
const PAGE = `page:${randomUUID()}`
const NOTEBOOK = `notebook:${randomUUID()}`

function loroUpdate(text: string): Uint8Array {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, text)
  return doc.export({ mode: 'update' })
}

function image(bytes: number[], ext = 'png'): string {
  const data = Buffer.from(bytes)
  const name = `${createHash('sha256').update(data).digest('hex')}.${ext}`
  writeFileSync(join(blobsDir, name), data)
  return name
}

function plainContents(): string {
  const db = openDatabase(plainFile, null, { readonly: true })
  try {
    return JSON.stringify(db.prepare('SELECT doc_id, hex(data) AS d FROM updates ORDER BY id').all())
  } finally {
    db.close()
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-migrate-'))
  plainFile = join(dir, 'slate.db')
  outFile = join(dir, 'slate-abcd.db')
  blobsDir = join(dir, 'blobs')
  mkdirSync(blobsDir)
  const store = new DocStore(plainFile)
  store.append(PAGE, loroUpdate('hello'))
  store.append(PAGE, loroUpdate('world'))
  store.append(NOTEBOOK, loroUpdate('nb'))
  store.replaceSearchPage({ pageId: PAGE, sectionId: 's', notebookId: 'n' }, [{ boxId: 'b', ord: 0, text: 'hello' }])
  store.close()
  image([1, 2, 3])
  image([4, 5], 'jpg')
})
afterEach(() => {
  delete process.env.SLATE_TEST_CRASH_AT
  rmSync(dir, { recursive: true, force: true })
})

describe('holdExclusive', () => {
  it('blocks a second connection from writing while held', () => {
    const held = holdExclusive(plainFile)
    const write = (): void => {
      const other = openDatabase(plainFile, null, { wal: false, timeoutMs: 0 })
      try {
        other.prepare("INSERT INTO settings (key, value) VALUES ('x', '1')").run()
      } finally {
        other.close()
      }
    }
    expect(write).toThrow(/locked|busy/i)
    held.close()
    write()
  })

  it('stops with OtherProgramHasNotesOpen when another connection is writing', () => {
    const other = openDatabase(plainFile, null)
    other.exec('BEGIN IMMEDIATE')
    expect(() => holdExclusive(plainFile)).toThrow(OtherProgramHasNotesOpen)
    other.exec('COMMIT')
    other.close()
  })
})

describe('copyAndEncrypt', () => {
  it('produces an encrypted copy with every row, doc and image, and leaves the plaintext alone', () => {
    const before = plainContents()
    const report = copyAndEncrypt({ plainFile, outFile, key, blobsDir })
    expect(report.images).toBe(2)
    expect(report.skipped).toEqual([])
    expect(existsSync(`${outFile}.tmp`)).toBe(false)
    expect(plainContents()).toBe(before)
    expect(() => openDatabase(outFile, null)).toThrow(WrongKey)
    const db = openDatabase(outFile, key)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    const store = new DocStore(db)
    expect(store.load(PAGE)).toHaveLength(2)
    expect(store.searchRows(null, 'hello')).toHaveLength(1)
    expect(new DbBlobStore(db).list()).toHaveLength(2)
    store.close()
  })

  it('refuses to overwrite an existing encrypted database', () => {
    writeFileSync(outFile, 'already here')
    expect(() => copyAndEncrypt({ plainFile, outFile, key, blobsDir })).toThrow(/already exists/)
    expect(readFileSync(outFile, 'utf8')).toBe('already here')
  })

  it('skips and reports an image whose bytes do not match its name', () => {
    writeFileSync(join(blobsDir, `${'c'.repeat(64)}.png`), Buffer.from([9, 9]))
    const report = copyAndEncrypt({ plainFile, outFile, key, blobsDir })
    expect(report.images).toBe(2)
    expect(report.skipped).toEqual([`${'c'.repeat(64)}.png`])
  })

  it('verification catches a copy that lost a row', () => {
    expect(() =>
      copyAndEncrypt({
        plainFile,
        outFile,
        key,
        blobsDir,
        afterStep: (step, tmp) => {
          if (step !== 'copy') return
          const db = openDatabase(tmp, null, { wal: false })
          db.exec('DELETE FROM updates WHERE id = (SELECT max(id) FROM updates)')
          db.close()
        },
      }),
    ).toThrow(MigrationVerifyFailed)
    expect(existsSync(outFile)).toBe(false)
  })

  it('verification catches a document Loro cannot load', () => {
    expect(() =>
      copyAndEncrypt({
        plainFile,
        outFile,
        key,
        blobsDir,
        afterStep: (step, tmp) => {
          if (step !== 'copy') return
          const db = openDatabase(tmp, null, { wal: false })
          db.prepare('UPDATE updates SET data = ? WHERE id = 1').run(Buffer.from('not a loro update at all'))
          db.close()
        },
      }),
    ).toThrow(MigrationVerifyFailed)
  })

  it.each(MIGRATION_STEPS)('a crash before %s leaves the plaintext authoritative and a re-run succeeds', (step) => {
    const before = plainContents()
    process.env.SLATE_TEST_CRASH_AT = step
    expect(() => copyAndEncrypt({ plainFile, outFile, key, blobsDir })).toThrow(/crash/i)
    expect(existsSync(outFile)).toBe(false)
    expect(plainContents()).toBe(before)
    delete process.env.SLATE_TEST_CRASH_AT
    copyAndEncrypt({ plainFile, outFile, key, blobsDir })
    const store = new DocStore(outFile, { key })
    expect(store.load(PAGE)).toHaveLength(2)
    store.close()
  })

  it.each(MIGRATION_STEPS)('a crash before %s leaves no temp copy behind (review N2)', (step) => {
    process.env.SLATE_TEST_CRASH_AT = step
    expect(() => copyAndEncrypt({ plainFile, outFile, key, blobsDir })).toThrow(/crash/i)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('a finished copy leaves no temp copy behind (review N2)', () => {
    copyAndEncrypt({ plainFile, outFile, key, blobsDir })
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('overwrites the plaintext temp copy before its name goes (review N2)', () => {
    const peek = join(dir, 'peek')
    copyAndEncrypt({
      plainFile,
      outFile,
      key,
      blobsDir,
      // A second name for the plaintext copy's inode sees what happens to its bytes.
      afterStep: (step, tmp) => {
        if (step === 'blobs') linkSync(tmp, peek)
      },
    })
    const left = readFileSync(peek)
    expect(left.length).toBeGreaterThan(0)
    expect(left.every((b) => b === 0)).toBe(true)
  })

  it('never follows a symlink planted at a temp name: the scrub zeroes only the copy itself (C3 re-review)', () => {
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'someone else’s file')
    copyAndEncrypt({
      plainFile,
      outFile,
      key,
      blobsDir,
      afterStep: (step, tmp) => {
        if (step === 'blobs') symlinkSync(victim, `${tmp}-shm`)
      },
    })
    expect(readFileSync(victim, 'utf8')).toBe('someone else’s file')
  })
})

describe('verifyDocIds', () => {
  it('returns ids that are not kind:uuidv4', () => {
    const store = new DocStore(plainFile)
    store.append('page:not-a-uuid', loroUpdate('x'))
    store.append(`page:${randomUUID().toUpperCase()}`, loroUpdate('y'))
    store.close()
    const db = openDatabase(plainFile, null)
    expect(verifyDocIds(db).sort()).toHaveLength(2)
    expect(verifyDocIds(db)).toContain('page:not-a-uuid')
    db.close()
  })

  it('accepts a clean store', () => {
    const db = openDatabase(plainFile, null)
    expect(verifyDocIds(db)).toEqual([])
    db.close()
  })
})

describe('removeStrayDatabases (review C5 merge check)', () => {
  it('tries every stray on its own: one it cannot delete does not leave the plaintext temp copies after it', () => {
    const d = mkdtempSync(join(tmpdir(), 'slate-strays-'))
    // Sorts first and cannot be unlinked (a directory); a plaintext temp copy sorts after it.
    mkdirSync(join(d, 'slate-a.db.tmp'))
    writeFileSync(join(d, 'slate-b.db.tmp'), 'plaintext notes')
    writeFileSync(join(d, 'slate-c.db.enc.tmp'), 'half a copy')
    expect(removeStrayDatabases(d)).toBe(1)
    expect(readdirSync(d).sort()).toEqual(['slate-a.db.tmp'])
  })
})

describe('cleanupPlaintext', () => {
  it('removes the plaintext database, images, caches and converter temp folders', () => {
    const temp = mkdtempSync(join(tmpdir(), 'slate-tmp-'))
    mkdirSync(join(temp, 'slate-one2html-abc'))
    mkdirSync(join(temp, 'other'))
    writeFileSync(`${plainFile}-wal`, '')
    writeFileSync(`${plainFile}-shm`, '')
    mkdirSync(join(dir, 'Cache'))
    mkdirSync(join(dir, 'Code Cache'))
    writeFileSync(join(dir, 'vault.json'), '{}')
    cleanupPlaintext(dir, temp)
    expect(readdirSync(dir).sort()).toEqual(['vault.json'])
    expect(readdirSync(temp)).toEqual(['other'])
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).toBe('{}')
  })

  it('removes interrupted copies and databases of other vaults, keeping the one local-keys.json names', () => {
    const temp = mkdtempSync(join(tmpdir(), 'slate-tmp-'))
    const names = ['slate-aaaa.db', 'slate-aaaa.db-wal', 'slate-aaaa.db-shm', 'slate-bbbb.db', 'slate-bbbb.db-wal', 'slate-aaaa.db.tmp', 'slate-aaaa.db.tmp-journal', 'slate-cccc.db.tmp']
    for (const n of names) writeFileSync(join(dir, n), 'x')
    writeFileSync(join(dir, 'local-keys.json'), JSON.stringify({ db: 'slate-aaaa.db' }))
    cleanupPlaintext(dir, temp)
    expect(readdirSync(dir).sort()).toEqual(['local-keys.json', 'slate-aaaa.db', 'slate-aaaa.db-shm', 'slate-aaaa.db-wal'])
  })

  it('without local-keys.json, removes every interrupted copy and every slate-*.db', () => {
    const temp = mkdtempSync(join(tmpdir(), 'slate-tmp-'))
    for (const n of ['slate-aaaa.db.tmp', 'slate-aaaa.db.tmp-journal', 'slate-aaaa.db']) writeFileSync(join(dir, n), 'x')
    cleanupPlaintext(dir, temp)
    expect(readdirSync(dir)).toEqual([])
  })
})
