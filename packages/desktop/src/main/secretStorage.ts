import { safeStorage, type SafeStorage } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The one wrapper around Electron's `safeStorage` (audit B-5; lint rule
 * `slate/secrets-through-secret-storage`). Only the async API: Electron 45 deprecates the
 * synchronous one and 46 removes it, and the async one reads what the synchronous one sealed.
 */

/** basic_text "encrypts" with a hard-coded password: never a place for a credential or a key. */
const REAL_KEYRINGS: ReadonlySet<string> = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

export type SecretStorePolicy = 'persist' | 'session-only' | 'refuse'
export type CryptoProfile = 'standard' | 'fips-140-3'

export class SecretStorageUnavailable extends Error {
  override name = 'SecretStorageUnavailable'
  constructor() {
    super('This computer has no system keyring Slate can use, so the secret is not stored')
  }
}

/** The slice of Electron's safeStorage this module uses; tests pass a fake. */
export type AsyncSafeStorage = Pick<SafeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync' | 'getSelectedStorageBackend'>

export interface SecretStorage {
  /** Whether a secret written now would be protected by a real OS keyring. */
  available(): Promise<boolean>
  seal(plain: string): Promise<Buffer>
  /** `rewrite` is set when the OS rotated its key: the caller re-seals and writes the file again. */
  open(sealed: Buffer): Promise<{ plain: string; rewrite: boolean }>
}

export function createSecretStorage(ss: AsyncSafeStorage, platform: NodeJS.Platform): SecretStorage {
  const available = async (): Promise<boolean> => {
    try {
      if (!(await ss.isAsyncEncryptionAvailable())) return false
      return platform !== 'linux' || REAL_KEYRINGS.has(ss.getSelectedStorageBackend())
    } catch {
      // A keychain API that throws counts as no keychain.
      return false
    }
  }
  return {
    available,
    seal: async (plain) => {
      if (!(await available())) throw new SecretStorageUnavailable()
      return ss.encryptStringAsync(plain)
    },
    open: async (sealed) => {
      if (!(await available())) throw new SecretStorageUnavailable()
      const { result, shouldReEncrypt } = await ss.decryptStringAsync(sealed)
      return { plain: result, rewrite: shouldReEncrypt }
    },
  }
}

/** This app's storage: Electron's safeStorage on this platform. Call after `app.whenReady()`. */
export function appSecretStorage(): SecretStorage {
  return createSecretStorage(safeStorage, process.platform)
}

/** standard: keep a credential for this session only when there is no keyring; fips-140-3: refuse it. */
export function credentialPolicy(available: boolean, profile: CryptoProfile): SecretStorePolicy {
  if (available) return 'persist'
  return profile === 'fips-140-3' ? 'refuse' : 'session-only'
}

/**
 * Deletes `file` only when it is the plain-text JSON token cache an older Slate wrote without a
 * keyring (the MSAL fallback B-5 removed). A sealed blob is kept: the keyring may only be late this
 * run. `rm` is not a secure erase; on APFS and SSDs nothing short of whole-disk encryption is.
 */
async function removeLegacyPlaintext(file: string): Promise<void> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return
  }
  try {
    if (typeof JSON.parse(text) !== 'object') return
  } catch {
    return
  }
  await rm(file, { force: true })
}

export interface SecretFile {
  get(): Promise<string | undefined>
  set(secret: string): Promise<void>
  clear(): Promise<void>
  /** Whether `set` survives a restart (false: the secret lives in memory until Slate quits). */
  persistent(): Promise<boolean>
}

/**
 * One secret in one file, sealed by the OS keyring; never written in plain text. Without a keyring
 * the secret is kept in memory for this session (`standard`) or not at all (`fips-140-3`).
 * C5 supplies the vault's real profile; until then every vault is `standard`.
 */
export function secretFile(file: string, storage: SecretStorage, profile: () => CryptoProfile = () => 'standard'): SecretFile {
  let session: string | undefined
  const policy = async () => credentialPolicy(await storage.available(), profile())
  const write = async (secret: string) => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, await storage.seal(secret), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  }
  return {
    async get() {
      const p = await policy()
      if (p !== 'persist') {
        await removeLegacyPlaintext(file)
        return p === 'session-only' ? session : undefined
      }
      let sealed: Buffer
      try {
        sealed = await readFile(file)
      } catch {
        return undefined
      }
      try {
        const { plain, rewrite } = await storage.open(sealed)
        if (rewrite && plain) await write(plain)
        return plain || undefined
      } catch {
        // A keychain reset makes the file unreadable: sign in again.
        return undefined
      }
    },
    async set(secret) {
      const p = await policy()
      if (p === 'refuse') throw new SecretStorageUnavailable()
      if (p === 'session-only') session = secret
      else await write(secret)
    },
    async clear() {
      session = undefined
      await rm(file, { force: true })
    },
    async persistent() {
      return (await policy()) === 'persist'
    },
  }
}
