import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthService, encryptedCachePlugin, type SecretStorage } from './auth'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-auth-'))
  dirs.push(dir)
  return join(dir, 'msal.bin')
}

// Reversible stand-in for the OS keychain.
const storage = (available = true): SecretStorage => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(s, 'utf8').reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString('utf8'),
})

function context(initial: string, hasChanged: boolean) {
  let cache = initial
  return {
    ctx: { cacheHasChanged: hasChanged, tokenCache: { serialize: () => cache, deserialize: (s: string) => void (cache = s) } },
    read: () => cache,
  }
}

describe('encryptedCachePlugin', () => {
  it('writes the cache encrypted and reads it back', async () => {
    const file = tempFile()
    const plugin = encryptedCachePlugin(file, storage())
    const json = '{"Account":{"a":1}}'
    await plugin.afterCacheAccess(context(json, true).ctx as never)
    expect(readFileSync(file).toString('utf8')).not.toContain('Account')
    const target = context('{}', false)
    await plugin.beforeCacheAccess(target.ctx as never)
    expect(target.read()).toBe(json)
  })

  it('falls back to plain JSON with a warning when encryption is unavailable', async () => {
    const file = tempFile()
    const warnings: string[] = []
    const plugin = encryptedCachePlugin(file, storage(false), (m) => warnings.push(m))
    await plugin.afterCacheAccess(context('{"x":1}', true).ctx as never)
    expect(readFileSync(file, 'utf8')).toBe('{"x":1}')
    expect(warnings).toHaveLength(1)
  })

  it('does not write an unchanged cache', async () => {
    const file = tempFile()
    await encryptedCachePlugin(file, storage()).afterCacheAccess(context('{}', false).ctx as never)
    expect(existsSync(file)).toBe(false)
  })
})

describe('createAuthService', () => {
  it('is not configured without a client id', async () => {
    const auth = createAuthService({ clientId: null, cacheFile: tempFile(), openBrowser: async () => {}, fake: false, storage: storage() })
    expect(await auth.status()).toEqual({ configured: false, signedIn: false })
  })

  it('fake auth signs in and hands out the fake token', async () => {
    const auth = createAuthService({ clientId: null, cacheFile: tempFile(), openBrowser: async () => {}, fake: true })
    await expect(auth.token(['Notes.Read'])).rejects.toThrow('not signed in')
    await auth.signIn()
    expect(await auth.status()).toEqual({ configured: true, signedIn: true, account: 'test@example.com' })
    expect(await auth.token(['Notes.Read'])).toBe('fake-token')
    await auth.signOut()
    expect((await auth.status()).signedIn).toBe(false)
  })

  it('fake auth stays signed in across restarts, like the real token cache', async () => {
    const cacheFile = tempFile()
    const make = () => createAuthService({ clientId: null, cacheFile, openBrowser: async () => {}, fake: true })
    await make().signIn()
    expect((await make().status()).signedIn).toBe(true)
    await make().signOut()
    expect((await make().status()).signedIn).toBe(false)
  })
})
