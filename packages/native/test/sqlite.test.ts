// SQLCipher inside slate_native.node (audit C3): keys only from handles (criteria 1 and 2, T-DB-03),
// and SQLCipher served by the module's libcrypto (T-DB-02, development mode; the FIPS-mode half runs
// in packages/desktop/src/main/db). Needs the addon (`npm run -w @slate/native build`).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseClass, loadNative, nativeErrorCode, type DatabaseConstructor, type SlateNative } from '../index'

const addonPath = join(__dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node')
const tmp = mkdtempSync(join(tmpdir(), 'slate-sqlite-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let n = 0
const file = () => join(tmp, `t${++n}.db`)
const MARKER = 'SQLCIPHER-MARKER-51c2'

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
  } catch (e) {
    return nativeErrorCode(e) ?? (e as { code?: string }).code ?? String(e)
  }
  return null
}

describe('SQLCipher in slate_native.node', () => {
  let native: SlateNative
  let Database: DatabaseConstructor

  beforeAll(() => {
    // Notes cannot open without the addon, so its tests do not skip: build it first.
    if (!existsSync(addonPath)) throw new Error(`${addonPath} is missing: run \`npm run -w @slate/native build\``)
    native = loadNative(addonPath)
    native.init('', '', false)
    Database = databaseClass(native)
  })

  it('is the better-sqlite3 API, with no way to key from JS bytes and no extension loading', () => {
    const db = new Database(file())
    expect(db.prepare('SELECT 1 + 1 AS two').get()).toEqual({ two: 2 })
    const anyDb = db as unknown as Record<string, unknown>
    expect(anyDb.key).toBeUndefined()
    expect(anyDb.rekey).toBeUndefined()
    expect(anyDb.loadExtension).toBeUndefined()
    // Review N1: no API that hands out the decrypted image or runs JS inside SQLite.
    for (const gone of ['serialize', 'backup', 'function', 'aggregate', 'table', 'unsafeMode']) expect(anyDb[gone], gone).toBeUndefined()
    expect(typeof db.keyWithHandle).toBe('function')
    expect(databaseClass(native)).toBe(Database)
    db.close()
  })

  it('encrypts with a key handle: the file holds no plaintext, and only the same key opens it', () => {
    const f = file()
    const key = native.keyRandom('db')
    const db = new Database(f)
    expect(db.keyWithHandle(key)).toBe(0)
    db.exec('CREATE TABLE t (v TEXT)')
    db.prepare('INSERT INTO t VALUES (?)').run(MARKER)
    db.close()
    expect(readFileSync(f).includes(MARKER)).toBe(false)

    const again = new Database(f)
    again.keyWithHandle(key)
    expect(again.prepare('SELECT v FROM t').get()).toEqual({ v: MARKER })
    again.close()

    const wrong = new Database(f)
    wrong.keyWithHandle(native.keyRandom('db'))
    expect(codeOf(() => wrong.prepare('SELECT v FROM t').get())).toBe('SQLITE_NOTADB')
    wrong.close()
  })

  it('rekeyWithHandle moves an encrypted database to a new key', () => {
    const f = file()
    const [a, b] = [native.keyRandom('db'), native.keyRandom('db')]
    const db = new Database(f)
    db.keyWithHandle(a)
    db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${MARKER}')`)
    expect(db.rekeyWithHandle(b)).toBe(0)
    db.close()
    const old = new Database(f)
    old.keyWithHandle(a)
    expect(codeOf(() => old.prepare('SELECT v FROM t').get())).toBe('SQLITE_NOTADB')
    old.close()
    const next = new Database(f)
    next.keyWithHandle(b)
    expect(next.prepare('SELECT v FROM t').get()).toEqual({ v: MARKER })
    next.close()
  })

  it('T-DB-03: a destroyed handle throws SCC_8 and leaves the connection unkeyed', () => {
    const f = file()
    const key = native.keyRandom('db')
    native.keyDestroy(key)
    const db = new Database(f)
    expect(codeOf(() => db.keyWithHandle(key))).toBe('SCC_8')
    expect(codeOf(() => db.rekeyWithHandle(key))).toBe('SCC_8')
    db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${MARKER}')`)
    db.close()
    expect(readFileSync(f).includes(MARKER)).toBe(true)
  })

  it('refuses anything but an exact handle number (SCC_1)', () => {
    const db = new Database(file())
    for (const bad of [undefined, '1', 1.5, -1, 2 ** 32, Number.NaN, Buffer.alloc(32)]) {
      expect(codeOf(() => (db.keyWithHandle as (h: unknown) => number)(bad))).toBe('SCC_1')
    }
    db.close()
  })

  it('criterion 2: key material cannot arrive as SQL text (every key pragma is refused)', () => {
    const f = file()
    const db = new Database(f)
    const hex = "x'" + '00'.repeat(32) + "'"
    for (const sql of [`key = "${hex}"`, `rekey = "${hex}"`, `hexkey = '${'00'.repeat(32)}'`, `hexrekey = '${'00'.repeat(32)}'`, `textkey = 'pw'`, `textrekey = 'pw'`, `KEY = 'pw'`, `main.key = 'pw'`, `key('pw')`, `"key" = 'pw'`, `[rekey] = 'pw'`, '`hexkey` = 00', `/**/key = 'pw'`]) {
      expect(codeOf(() => db.pragma(sql)), sql).toBe('SQLITE_AUTH')
    }
    db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${MARKER}')`)
    db.close()
    expect(readFileSync(f).includes(MARKER)).toBe(true)
  })

  it('T-DB-02 (development): SQLCipher runs on the module\'s OpenSSL; no FIPS claim without the provider', () => {
    const db = new Database(file())
    db.keyWithHandle(native.keyRandom('db'))
    expect(db.pragma('cipher_provider', { simple: true })).toBe('openssl')
    expect(db.pragma('cipher_provider_version', { simple: true })).toBe(native.status().libcrypto)
    expect(db.pragma('cipher_fips_status', { simple: true })).toBe('0')
    expect(db.pragma('temp_store', { simple: true })).toBe(0)
    expect(String(db.pragma('cipher_version', { simple: true }))).toMatch(/^4\.19\.0 community$/)
    db.close()
  })

  it('review M1: SQL text can neither attach, detach nor export; the native import is the only way in', () => {
    const plain = file()
    const p = new Database(plain)
    p.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${MARKER}')`)
    p.pragma('user_version = 7')
    p.close()
    const key = native.keyRandom('db')
    const db = new Database(file())
    db.keyWithHandle(key)
    for (const sql of [`ATTACH DATABASE '${plain}' AS a KEY 'attacker'`, `ATTACH '${plain}' AS a KEY ''`, `ATTACH '${plain}' AS a`, 'DETACH DATABASE a']) {
      expect(codeOf(() => db.exec(sql)), sql).toBe('SQLITE_AUTH')
    }
    // SQLite reports a refused function as SQLITE_ERROR "not authorized to use function".
    for (const sql of ["SELECT sqlcipher_export('main')", "SELECT sqlcipher_export('main', 'main')", "SELECT SQLCIPHER_EXPORT('main')"]) {
      expect(() => db.prepare(sql).get(), sql).toThrow(/not authorized to use function: sqlcipher_export/i)
    }
    const out = db.name
    expect(db.importPlaintextDatabase(plain)).toBe(0)
    expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: MARKER })
    expect(db.pragma('user_version', { simple: true })).toBe(7)
    expect(codeOf(() => db.exec(`ATTACH '${plain}' AS a KEY ''`))).toBe('SQLITE_AUTH')
    db.close()
    expect(readFileSync(out).includes(MARKER)).toBe(false)

    const unkeyed = new Database(file())
    expect(codeOf(() => unkeyed.importPlaintextDatabase(plain))).toBe('SCC_2')
    unkeyed.close()
  })

  it('review M2: no cipher setting can be changed from SQL; the read-only queries the app needs still work', () => {
    const db = new Database(file())
    db.keyWithHandle(native.keyRandom('db'))
    for (const sql of [
      'cipher_default_use_hmac = OFF', 'cipher_default_plaintext_header_size = 32', 'cipher_default_page_size = 1024',
      'cipher_default_kdf_iter = 1', 'cipher_use_hmac = OFF', 'cipher_plaintext_header_size = 32', 'cipher_page_size = 1024',
      "cipher_hmac_algorithm = 'HMAC_SHA1'", "cipher_kdf_algorithm = 'PBKDF2_HMAC_SHA1'", 'kdf_iter = 1', 'fast_kdf_iter = 1',
      "cipher_log_level = 'TRACE'", "cipher_log = '/tmp/slate-cipher.log'", "cipher_log_source = 'ANY'", 'cipher_memory_security = OFF',
      'cipher_compatibility = 3', 'cipher_migrate', 'cipher_default_settings', 'cipher_settings', "rekey_cipher = 'aes-128-cbc'", 'cipher_salt',
      'cipher_profile = \'/tmp/p\'', 'cipher_add_random = "x\'00\'"', 'cipher_status', 'cipher_store_pass = 1', "CIPHER_LOG_LEVEL = 'TRACE'", '"cipher_log_level" = \'TRACE\'',
    ]) {
      expect(codeOf(() => db.pragma(sql)), sql).toBe('SQLITE_AUTH')
    }
    expect(db.pragma('cipher_memory_security = ON')).toBeDefined()
    for (const q of ['cipher_version', 'cipher_provider', 'cipher_provider_version', 'cipher_fips_status', 'cipher_memory_security', 'cipher_use_hmac', 'cipher_page_size', 'cipher_plaintext_header_size', 'cipher_hmac_algorithm', 'cipher_kdf_algorithm', 'kdf_iter']) {
      expect(codeOf(() => db.pragma(q, { simple: true })), q).toBeNull()
    }
    // The build has no SQLCipher logging at all, so its TRACE format-string crash cannot be reached.
    db.exec('CREATE TABLE t (v BLOB); INSERT INTO t VALUES (randomblob(100000))')
    db.close()
  })

  it('review L2 (C4): a non-approved database key keys a database until requireApprovedKeys is set', () => {
    // This file runs the module without the FIPS provider, where every handle carries bit 31, and never
    // sets requireApprovedKeys (it is one-way for the process). The refusal once it is set (SCC_16) is the
    // next test, run in a child process (latchChild.mjs).
    const db = new Database(file())
    expect(codeOf(() => db.keyWithHandle(native.keyRandom('db')))).toBeNull()
    db.close()
  })

  it('C4: requireApprovedKeys is one-way, and after it a non-approved key cannot key a database (SCC_16)', () => {
    // Before the latch a standard-profile vault (LK wrapped under an HKDF subkey) keys its database, also on
    // the FIPS provider: FIPS builds create standard vaults (docs/compliance/decisions.md). C5 sets the latch
    // for fips-140-3 vaults. One-way for the process, so it runs in a child.
    const dir = mkdtempSync(join(tmp, 'latch-'))
    const r = spawnSync(process.execPath, [join(__dirname, 'latchChild.mjs'), dir], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ approvedBit: true, before: false, keyBefore: 0, latch: 0, after: true, keyAfter: 'SCC_16', rekeyAfter: 'SCC_16' })
  })

  it('C4: only a database key reaches SQLCipher; a password, master or data key is refused (SCC_17)', () => {
    const password = native.argon2id(new TextEncoder().encode('pw'), new Uint8Array(16), 32, 1)
    for (const key of [password, native.keyRandom('master'), native.keyRandom()]) {
      const db = new Database(file())
      expect(codeOf(() => db.keyWithHandle(key))).toBe('SCC_17')
      expect(codeOf(() => db.rekeyWithHandle(key))).toBe('SCC_17')
      db.close()
    }
  })

  it('re-review R-L1: page_size, SQLCipher\'s alias of cipher_page_size, cannot be set on a keyed connection', () => {
    const f = file()
    const key = native.keyRandom('db')
    const db = new Database(f)
    db.keyWithHandle(key)
    for (const sql of ['page_size = 1024', 'PAGE_SIZE = 65536', 'main.page_size = 512']) expect(codeOf(() => db.pragma(sql)), sql).toBe('SQLITE_AUTH')
    expect(String(db.pragma('page_size', { simple: true }))).toBe('4096')
    db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${MARKER}')`)
    db.close()
    const again = new Database(f)
    again.keyWithHandle(key)
    expect(again.prepare('SELECT v FROM t').get()).toEqual({ v: MARKER })
    again.close()
    // A plaintext connection keeps SQLite's own pragma.
    const plain = new Database(file())
    expect(codeOf(() => plain.pragma('page_size = 8192'))).toBeNull()
    plain.close()
  })

  it('re-review R-N1: importPlaintextDatabase reads an existing source read-only into an empty keyed target', () => {
    const src = file()
    const p = new Database(src)
    p.exec(`CREATE TABLE s (v TEXT); INSERT INTO s VALUES ('${MARKER}')`)
    p.close()
    const before = readFileSync(src)
    const missing = join(tmp, 'missing.db')
    const target = new Database(file())
    target.keyWithHandle(native.keyRandom('db'))
    expect(codeOf(() => target.importPlaintextDatabase(missing))).toBe('SQLITE_CANTOPEN')
    expect(existsSync(missing)).toBe(false)
    expect(target.importPlaintextDatabase(src)).toBe(0)
    expect(readFileSync(src).equals(before)).toBe(true)
    // A second import would merge into a database that is no longer empty.
    expect(codeOf(() => target.importPlaintextDatabase(src))).toBe('SCC_2')
    target.close()
    // URI file names (and SQLCipher's URI key parameters) never come from JavaScript.
    expect(codeOf(() => new Database(`file:${file()}?key=abc`))).toBe('SCC_1')
  })

  it('review C3 FC-L1 (C6): the error state closes a connection held by a paused iterator at once, without a crash', () => {
    const dir = mkdtempSync(join(tmp, 'poison-paused-'))
    const r = spawnSync(process.execPath, [join(__dirname, 'poisonChild.mjs'), 'paused', dir], { encoding: 'utf8' })
    expect(r.signal, r.stderr).toBeNull()
    expect(r.status, r.stderr).toBe(0)
    const out = Object.fromEntries((JSON.parse(r.stdout) as Array<[string, string, unknown]>).map(([label, how, v]) => [label, [how, v]]))
    expect(out.first).toEqual(['ok', { v: 1 }])
    // Closed while the iterator is still paused: SQLCipher's codec (and its key) is gone before it resumes.
    expect(out.open).toEqual(['ok', false])
    expect(out.next?.[0]).toBe('threw')
    expect(out.return).toEqual(['ok', true])
    expect(out.openAfter).toEqual(['ok', false])
  })

  it.each(['iter', 'log', 'logexec'])('re-review R-M1: closing from the error state mid-%s neither crashes nor writes', (mode) => {
    const dir = mkdtempSync(join(tmp, `poison-${mode}-`))
    const r = spawnSync(process.execPath, [join(__dirname, 'poisonChild.mjs'), mode, dir], { encoding: 'utf8' })
    expect(r.signal, r.stderr).toBeNull()
    expect(r.status, r.stderr).toBe(0)
    const out = Object.fromEntries((JSON.parse(r.stdout) as Array<[string, string, unknown]>).map(([label, how, v]) => [label, [how, v]]))
    expect(out.open).toEqual(['ok', false])
    if (mode === 'iter') {
      expect(out.first).toEqual(['ok', { v: 1 }])
      expect(out.next?.[0]).toBe('threw')
      expect(out.again?.[0]).toBe('threw')
    } else {
      expect((out.run ?? out.exec)?.[0]).toBe('threw')
      // Nothing reached the file: the statement never ran.
      for (const [name, size] of out.files?.[1] as Array<[string, number]>) expect(size, name).toBe(0)
    }
  })

  it('review M3: the error state closes every open connection and refuses new ones and new keys', () => {
    const f = file()
    const key = native.keyRandom('db')
    const open = new Database(f)
    open.keyWithHandle(key)
    open.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${MARKER}')`)
    const stmt = open.prepare('SELECT v FROM t')
    native.enterErrorState()
    expect(open.open).toBe(false)
    expect(() => open.exec("INSERT INTO t VALUES ('after')")).toThrow(/not open/)
    expect(() => stmt.get()).toThrow()
    expect(codeOf(() => new Database(file()))).toBe('SCC_12')
  })
})
