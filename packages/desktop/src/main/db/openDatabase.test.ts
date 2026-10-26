import { describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SlateNative } from '@slate/native'
import { checkCipher, CipherCheckFailed, openDatabase, WrongKey, type Database } from './openDatabase'
import { dbModule, provideDbModule } from './dbModule'
import { testHasProvider, testKey } from './testModule'
import { importKey } from '../../../test/vaultKeys'
import { DocStore } from '../store'
import manifest from './fixtures/sqlcipher4-legacy.json'

const MARKER = 'ZEBRA-MARKER-7f3a'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'slate-opendb-')), 'slate.db')
}

describe('openDatabase', () => {
  it('opens a plaintext database in WAL with temp_store in memory', () => {
    const db = openDatabase(tempFile(), null)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('temp_store', { simple: true })).toBe(2)
    db.close()
  })

  it('refuses a wrong key with WrongKey and leaves the file untouched', () => {
    const file = tempFile()
    const key = testKey()
    const store = new DocStore(openDatabase(file, key))
    store.append('page:x', new Uint8Array([1, 2, 3]))
    store.close()
    const before = readFileSync(file)
    expect(() => openDatabase(file, testKey())).toThrow(WrongKey)
    expect(() => openDatabase(file, null)).toThrow(WrongKey)
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(existsSync(`${file}-wal`)).toBe(false)
    const again = openDatabase(file, key)
    expect(again.prepare('SELECT count(*) AS n FROM updates').get()).toEqual({ n: 1 })
    again.close()
  })

  it('keeps page updates and search rows out of the file and WAL in plaintext', () => {
    const file = tempFile()
    const db = openDatabase(file, testKey())
    const store = new DocStore(db)
    store.append('page:x', new TextEncoder().encode(MARKER))
    store.replaceSearchPage({ pageId: 'page:x', sectionId: 's', notebookId: 'n' }, [{ boxId: 'b', ord: 0, text: MARKER }])
    const scan = (): boolean => [file, `${file}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(MARKER))
    expect(scan()).toBe(false)
    store.close()
    expect(scan()).toBe(false)
  })

  it('a plaintext database does contain the marker (the scan works)', () => {
    const file = tempFile()
    const store = new DocStore(openDatabase(file, null))
    store.append('page:x', new TextEncoder().encode(MARKER))
    store.close()
    expect(readFileSync(file).includes(MARKER)).toBe(true)
  })
})

describe('SQLCipher on the module boundary (audit C3)', () => {
  it('T-DB-01: a database written by the audited SQLite3MultipleCiphers build opens unchanged', () => {
    const file = tempFile()
    copyFileSync(join(__dirname, 'fixtures', 'sqlcipher4-legacy.db'), file)
    const key = importKey(Buffer.from(manifest.keyHex, 'hex'), 'db')
    const db = openDatabase(file, key, { wal: false })
    dbModule().native.keyDestroy(key)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    for (const [table, rows] of Object.entries(manifest.rows)) {
      expect(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get(), table).toEqual({ n: rows })
    }
    expect(new DocStore(db).searchRows(null, 'fixture search')).toHaveLength(1)
    db.close()
  })

  it('T-DB-01: the fixture refuses a different key (it really is encrypted)', () => {
    const file = tempFile()
    copyFileSync(join(__dirname, 'fixtures', 'sqlcipher4-legacy.db'), file)
    expect(() => openDatabase(file, testKey(), { wal: false })).toThrow(WrongKey)
    expect(() => openDatabase(file, null, { wal: false })).toThrow(WrongKey)
  })

  it('T-DB-02: a keyed connection runs on the module\'s OpenSSL, in FIPS mode when the provider is loaded', () => {
    const db = openDatabase(tempFile(), testKey())
    expect(db.pragma('cipher_provider', { simple: true })).toBe('openssl')
    expect(db.pragma('cipher_provider_version', { simple: true })).toBe(dbModule().native.status().libcrypto)
    expect(db.pragma('temp_store', { simple: true })).toBe(2)
    expect(db.pragma('cipher_fips_status', { simple: true })).toBe(testHasProvider ? '1' : '0')
    expect(db.pragma('cipher_memory_security', { simple: true })).toBe(testHasProvider ? '1' : '0')
    db.close()
  })

  it('T-DB-02: with requireFips and SQLCipher not in FIPS mode, the check throws and fails closed', () => {
    const answers: Record<string, string> = {
      cipher_provider: 'openssl', cipher_provider_version: 'OpenSSL 3.5.9', cipher_fips_status: '0', cipher_use_hmac: '1', cipher_page_size: '4096',
      cipher_plaintext_header_size: '0', cipher_hmac_algorithm: 'HMAC_SHA512', cipher_kdf_algorithm: 'PBKDF2_HMAC_SHA512',
    }
    const pragmas: string[] = []
    const db = { pragma: (p: string) => (pragmas.push(p), answers[p]) } as unknown as Database.Database
    const enterErrorState = vi.fn(() => 0 as const)
    const native = { enterErrorState, status: () => ({ fipsActive: true, libcrypto: 'OpenSSL 3.5.9' }) } as unknown as SlateNative
    expect(() => checkCipher(db, { native, requireFips: true })).toThrow(CipherCheckFailed)
    expect(enterErrorState).toHaveBeenCalledTimes(1)

    answers.cipher_fips_status = '1'
    expect(() => checkCipher(db, { native, requireFips: true })).not.toThrow()
    expect(pragmas).toContain('cipher_memory_security = ON')

    // Any other crypto provider (CommonCrypto is SQLCipher's default on macOS) is refused in every mode.
    answers.cipher_provider = 'commoncrypto'
    const devNative = { enterErrorState, status: () => ({ fipsActive: false, libcrypto: 'OpenSSL 3.5.9' }) } as unknown as SlateNative
    expect(() => checkCipher(db, { native: devNative, requireFips: false })).toThrow(CipherCheckFailed)
    expect(enterErrorState).toHaveBeenCalledTimes(2)
  })

  it('review M2: checkCipher refuses weakened cipher settings', () => {
    const good: Record<string, string> = {
      cipher_provider: 'openssl', cipher_fips_status: '1', cipher_use_hmac: '1', cipher_page_size: '4096', cipher_plaintext_header_size: '0',
      cipher_hmac_algorithm: 'HMAC_SHA512', cipher_kdf_algorithm: 'PBKDF2_HMAC_SHA512', cipher_provider_version: 'OpenSSL 3.5.9',
    }
    const enterErrorState = vi.fn(() => 0 as const)
    const native = { enterErrorState, status: () => ({ fipsActive: true, libcrypto: 'OpenSSL 3.5.9' }) } as unknown as SlateNative
    const dbWith = (answers: Record<string, string>) => ({ pragma: (p: string) => answers[p] }) as unknown as Database.Database
    expect(() => checkCipher(dbWith(good), { native, requireFips: true })).not.toThrow()
    for (const [name, bad] of [['cipher_use_hmac', '0'], ['cipher_page_size', '1024'], ['cipher_plaintext_header_size', '32'], ['cipher_hmac_algorithm', 'HMAC_SHA1'], ['cipher_kdf_algorithm', 'PBKDF2_HMAC_SHA1'], ['cipher_provider_version', 'OpenSSL 1.1.1']] as const) {
      expect(() => checkCipher(dbWith({ ...good, [name]: bad }), { native, requireFips: true }), name).toThrow(CipherCheckFailed)
    }
    expect(enterErrorState).toHaveBeenCalledTimes(6)
  })

  it('review L4: openDatabase checks the cipher on every keyed open, before the first read', () => {
    const real = dbModule()
    const file = tempFile()
    const key = testKey()
    openDatabase(file, key).close()
    // The same addon (and SQLCipher), behind a module that claims another libcrypto: the check must fire.
    const enterErrorState = vi.fn(() => 0 as const)
    const other = Object.create(real.native, {
      status: { value: () => ({ ...real.native.status(), libcrypto: 'OpenSSL 0.0.0 not this one' }) },
      enterErrorState: { value: enterErrorState },
    }) as SlateNative
    provideDbModule(() => ({ native: other, requireFips: false }))
    try {
      expect(() => openDatabase(file, key)).toThrow(CipherCheckFailed)
      expect(enterErrorState).toHaveBeenCalledTimes(1)
    } finally {
      provideDbModule(() => real)
    }
  })

  it('review L2 (C4): only a database key opens the database; an Argon2id key is refused in any mode (SCC_17)', () => {
    // C4 moved this from "approved mode" to key usage: a password-class key never reaches SQLCipher, and a
    // non-approved database key is refused once the profile calls requireApprovedKeys (packages/native/test/
    // sqlite.test.ts, in a child, because that latch is one-way). FIPS builds also create standard vaults.
    const { native } = dbModule()
    const argon = native.argon2id(new TextEncoder().encode('password'), new Uint8Array(16), 32, 1)
    let code: unknown = null
    try {
      openDatabase(tempFile(), argon).close()
    } catch (e) {
      code = (e as { code?: unknown }).code
    }
    expect(code).toBe('SCC_17')
  })

  it('T-DB-03: a destroyed key handle throws SCC_8 and no database is opened', () => {
    const file = tempFile()
    const key = testKey()
    dbModule().native.keyDestroy(key)
    let code: unknown
    try {
      openDatabase(file, key)
    } catch (e) {
      code = (e as { code?: unknown }).code
    }
    expect(code).toBe('SCC_8')
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(file) ? readFileSync(file).length : 0).toBe(0)
  })

  it('criterion 2: the key never appears in SQL text (the key pragmas are refused)', () => {
    const db = openDatabase(tempFile(), null)
    expect(() => db.pragma(`key = "x'${'00'.repeat(32)}'"`)).toThrow(/not authorized/)
    db.close()
  })
})
