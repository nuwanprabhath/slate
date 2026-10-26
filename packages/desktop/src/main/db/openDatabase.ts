// The only way any code opens the notes database (audit C3). SQLite is SQLCipher compiled into
// @slate/native; a key enters it only as a module key handle, never as bytes or SQL text.
import { databaseClass, type Database, type KeyHandle } from '@slate/native'
import { assertNotesMayOpen, dbModule, type DbModule } from './dbModule'

export type { Database }

/** The key did not open the file (or the file is encrypted and no key was given). */
export class WrongKey extends Error {
  constructor(file: string) {
    super(`The key does not open ${file}`)
    this.name = 'WrongKey'
  }
}

/** SQLCipher is not running on the module's OpenSSL in the mode the build requires (T-DB-02). */
export class CipherCheckFailed extends Error {
  readonly selfTest = 'POST-MODULE-STATUS'
  constructor(detail: string) {
    super(`POST-MODULE-STATUS: ${detail}`)
    this.name = 'CipherCheckFailed'
  }
}

/** SQLCipher 4's defaults, which every Slate database uses (review M2: SQL may no longer change them). */
const CIPHER_SETTINGS = {
  cipher_use_hmac: '1',
  cipher_page_size: '4096',
  cipher_plaintext_header_size: '0',
  cipher_hmac_algorithm: 'HMAC_SHA512',
  cipher_kdf_algorithm: 'PBKDF2_HMAC_SHA512',
} as const

function cipherProblem(db: Database.Database, mod: DbModule, fips: boolean): string | null {
  const read = (value: unknown) => String(value)
  const provider = read(db.pragma('cipher_provider', { simple: true }))
  if (provider !== 'openssl') return `cipher_provider is ${provider}, not openssl`
  // The module's own libcrypto, not another OpenSSL that happens to be loaded in the process.
  const version = read(db.pragma('cipher_provider_version', { simple: true }))
  if (version !== mod.native.status().libcrypto) return `SQLCipher runs on ${version}, not the module's libcrypto`
  if (fips && read(db.pragma('cipher_fips_status', { simple: true })) !== '1') return 'cipher_fips_status is not 1'
  const settings: Record<keyof typeof CIPHER_SETTINGS, string> = {
    cipher_use_hmac: read(db.pragma('cipher_use_hmac', { simple: true })),
    cipher_page_size: read(db.pragma('cipher_page_size', { simple: true })),
    cipher_plaintext_header_size: read(db.pragma('cipher_plaintext_header_size', { simple: true })),
    cipher_hmac_algorithm: read(db.pragma('cipher_hmac_algorithm', { simple: true })),
    cipher_kdf_algorithm: read(db.pragma('cipher_kdf_algorithm', { simple: true })),
  }
  for (const [name, want] of Object.entries(CIPHER_SETTINGS)) {
    const got = settings[name as keyof typeof CIPHER_SETTINGS]
    if (got !== want) return `${name} is ${got}, not ${want}`
  }
  return null
}

/**
 * §4.9 "Database checks", on every keyed open, right after the key and before anything is read:
 * SQLCipher runs on the module's OpenSSL with SQLCipher 4's settings, and on the FIPS provider
 * whenever the build requires it or the module runs in approved mode. Any other answer puts the
 * module in the error state, which also closes every connection (fail closed; C6's failClosed
 * replaces this call), and throws. In approved mode SQLCipher also wipes the memory it frees (D-8).
 */
export function checkCipher(db: Database.Database, mod: DbModule): void {
  const fips = mod.requireFips || mod.native.status().fipsActive
  const problem = cipherProblem(db, mod, fips)
  if (problem) {
    try {
      mod.native.enterErrorState()
    } catch {
      // Already in the error state; the throw below still stands.
    }
    throw new CipherCheckFailed(problem)
  }
  if (fips) db.pragma('cipher_memory_security = ON')
}

/**
 * Review C6 (S-7 c): the connection, and every statement it prepares, report each error they throw before the
 * caller sees it. Methods are wrapped once per name; everything else passes through untouched.
 */
function watched<T extends object>(target: T, report: (e: unknown) => void): T {
  const wrapped = new Map<PropertyKey, unknown>()
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t)
      if (typeof value !== 'function') return value
      let fn = wrapped.get(prop)
      if (!fn) {
        fn = (...args: unknown[]) => {
          try {
            const out: unknown = Reflect.apply(value, t, args)
            // A statement carries on reporting for its connection.
            return prop === 'prepare' && typeof out === 'object' && out !== null ? watched(out, report) : out
          } catch (e) {
            report(e)
            throw e
          }
        }
        wrapped.set(prop, fn)
      }
      return fn
    },
  })
}

/** Nothing writes to the file before the key is proven. `wal: false` leaves the journal mode as the file has it (migration switches it itself). */
export function openDatabase(file: string, key: KeyHandle | null, opts: { readonly?: boolean; wal?: boolean; timeoutMs?: number } = {}): Database.Database {
  assertNotesMayOpen('openDatabase')
  const mod = dbModule()
  const DatabaseClass = databaseClass(mod.native)
  const report = mod.onDatabaseError
  let opened: Database.Database
  try {
    opened = new DatabaseClass(file, { readonly: opts.readonly ?? false, timeout: opts.timeoutMs ?? 3000 })
  } catch (e) {
    report?.(e)
    throw e
  }
  const db = report ? watched(opened, report) : opened
  try {
    if (key !== null) {
      db.keyWithHandle(key)
      checkCipher(db, mod)
    }
    db.pragma('temp_store = MEMORY')
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get()
    } catch (err) {
      // A busy or locked file is not a wrong key.
      if ((err as { code?: string }).code === 'SQLITE_NOTADB') throw new WrongKey(file)
      throw err
    }
    if (!opts.readonly && opts.wal !== false) {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
    }
    return db
  } catch (err) {
    db.close()
    throw err
  }
}
