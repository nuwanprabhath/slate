import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecretStorage, credentialPolicy, secretFile, SecretStorageUnavailable, type AsyncSafeStorage, type SecretStorage } from './secretStorage'

/** Electron's async safeStorage stand-in: reversible, so a test can see what reached the disk. */
function fakeSafeStorage(over: Partial<{ available: boolean; backend: ReturnType<AsyncSafeStorage['getSelectedStorageBackend']>; reEncrypt: boolean; decrypt: (b: Buffer) => string }> = {}) {
  const calls: string[] = []
  const ss: AsyncSafeStorage = {
    isAsyncEncryptionAvailable: async () => over.available ?? true,
    encryptStringAsync: async (s) => {
      calls.push('encrypt')
      return Buffer.from('sealed:' + Buffer.from(s).toString('hex'))
    },
    decryptStringAsync: async (b) => {
      calls.push('decrypt')
      const result = over.decrypt ? over.decrypt(b) : Buffer.from(b.toString().slice('sealed:'.length), 'hex').toString()
      return { result, shouldReEncrypt: over.reEncrypt ?? false }
    },
    getSelectedStorageBackend: () => over.backend ?? 'gnome_libsecret',
  }
  return { ss, calls }
}

const temp = () => mkdtempSync(join(tmpdir(), 'slate-secret-'))

describe('createSecretStorage (B-5)', () => {
  it('T-B-05: basic_text on Linux is not available, seal throws SecretStorageUnavailable, and a credential is kept for the session only', async () => {
    const { ss, calls } = fakeSafeStorage({ backend: 'basic_text' })
    const storage = createSecretStorage(ss, 'linux')
    expect(await storage.available()).toBe(false)
    await expect(storage.seal('token')).rejects.toThrow(SecretStorageUnavailable)
    await expect(storage.open(Buffer.from('sealed:00'))).rejects.toThrow(SecretStorageUnavailable)
    expect(calls).toEqual([])
    expect(credentialPolicy(false, 'standard')).toBe('session-only')
    expect(credentialPolicy(false, 'fips-140-3')).toBe('refuse')
    expect(credentialPolicy(true, 'fips-140-3')).toBe('persist')
  })

  it('takes only a real keyring on Linux, and the OS store elsewhere', async () => {
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'] as const) expect(await createSecretStorage(fakeSafeStorage({ backend }).ss, 'linux').available()).toBe(true)
    for (const backend of ['basic_text', 'unknown'] as const) expect(await createSecretStorage(fakeSafeStorage({ backend }).ss, 'linux').available()).toBe(false)
    expect(await createSecretStorage(fakeSafeStorage({ backend: 'unknown' }).ss, 'darwin').available()).toBe(true)
    expect(await createSecretStorage(fakeSafeStorage({ available: false }).ss, 'darwin').available()).toBe(false)
  })

  it('seals and opens through the async API, passing on a key rotation as `rewrite`', async () => {
    const storage = createSecretStorage(fakeSafeStorage({ reEncrypt: true }).ss, 'darwin')
    const sealed = await storage.seal('hello')
    expect(sealed.toString()).not.toContain('hello')
    expect(await storage.open(sealed)).toEqual({ plain: 'hello', rewrite: true })
  })
})

function storageOver(ss: AsyncSafeStorage): SecretStorage {
  return createSecretStorage(ss, 'darwin')
}

// Waits on the maintainer's macOS fixture; the ready body is openSyncSealedFixture in e2e/syncSealedFixture.ts.
// C8 criterion 3 runs on the maintainer's Mac against their Keychain: e2e/safeStorageMigration.keychain.ts (npm run e2e:keychain).

describe('secretFile', () => {
  it('stores the secret sealed, 0600, and reads it back', async () => {
    const file = join(temp(), 'sub', 'token.bin')
    const secret = secretFile(file, storageOver(fakeSafeStorage().ss))
    expect(await secret.persistent()).toBe(true)
    await secret.set('ghp_secret')
    expect(readFileSync(file, 'utf8')).not.toContain('ghp_secret')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await secretFile(file, storageOver(fakeSafeStorage().ss)).get()).toBe('ghp_secret')
    await secret.clear()
    expect(existsSync(file)).toBe(false)
    expect(await secret.get()).toBeUndefined()
  })

  it('re-seals and rewrites the file when the OS asks for it', async () => {
    const file = join(temp(), 'token.bin')
    await secretFile(file, storageOver(fakeSafeStorage().ss)).set('x')
    const { ss, calls } = fakeSafeStorage({ reEncrypt: true })
    expect(await secretFile(file, storageOver(ss)).get()).toBe('x')
    expect(calls).toEqual(['decrypt', 'encrypt'])
  })

  it('without a keyring keeps the secret in memory for this session and never writes it', async () => {
    const file = join(temp(), 'token.bin')
    const secret = secretFile(file, createSecretStorage(fakeSafeStorage({ backend: 'basic_text' }).ss, 'linux'))
    expect(await secret.persistent()).toBe(false)
    await secret.set('ghp_secret')
    expect(existsSync(file)).toBe(false)
    expect(await secret.get()).toBe('ghp_secret')
    await secret.clear()
    expect(await secret.get()).toBeUndefined()
  })

  it('without a keyring deletes a file an older Slate wrote in plain text', async () => {
    const file = join(temp(), 'msal-cache.bin')
    writeFileSync(file, '{"RefreshToken":{}}')
    const secret = secretFile(file, createSecretStorage(fakeSafeStorage({ backend: 'basic_text' }).ss, 'linux'))
    expect(await secret.get()).toBeUndefined()
    expect(existsSync(file)).toBe(false)
  })

  it('review L1: a sealed file survives a run without a keyring (the keyring may only be late)', async () => {
    const file = join(temp(), 'token.bin')
    await secretFile(file, storageOver(fakeSafeStorage().ss)).set('ghp_secret')
    const offline = secretFile(file, createSecretStorage(fakeSafeStorage({ backend: 'basic_text' }).ss, 'linux'))
    expect(await offline.get()).toBeUndefined()
    expect(existsSync(file)).toBe(true)
    expect(await secretFile(file, storageOver(fakeSafeStorage().ss)).get()).toBe('ghp_secret')
  })

  it('refuses to keep a secret at all under fips-140-3 without a keyring', async () => {
    const secret = secretFile(join(temp(), 't.bin'), createSecretStorage(fakeSafeStorage({ backend: 'basic_text' }).ss, 'linux'), () => 'fips-140-3')
    await expect(secret.set('x')).rejects.toThrow(SecretStorageUnavailable)
    expect(await secret.get()).toBeUndefined()
  })

  it('treats an unreadable file (keychain reset, corrupt) as no secret', async () => {
    const file = join(temp(), 'token.bin')
    writeFileSync(file, 'garbage')
    const ss = fakeSafeStorage({
      decrypt: () => {
        throw new Error('Keychain access denied')
      },
    }).ss
    expect(await secretFile(file, storageOver(ss)).get()).toBeUndefined()
  })
})
