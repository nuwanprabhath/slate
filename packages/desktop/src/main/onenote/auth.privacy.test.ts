import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import { DISCLOSURES } from '../../shared/privacy/consent'
import { ConsentRequired, setPrivacySource } from '../privacy/gate'
import { createSecretStorage, secretFile } from '../secretStorage'
import { PublicClientApplication } from '@azure/msal-node'
import { createAuthService, encryptedCachePlugin, IMPORT_SCOPES, SIGN_IN_SCOPES, type AuthService } from './auth'

const dirs: string[] = []
afterEach(() => {
  setPrivacySource(() => null)
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const rec = (f: 'microsoftSignIn' | 'oneDriveSync') => ({ grantedAt: 1, textVersion: DISCLOSURES[f].textVersion, source: 'user' as const })
const consent = (...fs: Array<'microsoftSignIn' | 'oneDriveSync'>) =>
  setPrivacySource(() => ({ ...DEFAULT_SETTINGS, gdprStrictMode: true, consents: Object.fromEntries(fs.map((f) => [f, rec(f)])) }))

const keyring = createSecretStorage(
  {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => Buffer.from(s, 'utf8').reverse(),
    decryptStringAsync: async (b) => ({ result: Buffer.from(b).reverse().toString('utf8'), shouldReEncrypt: false }),
    getSelectedStorageBackend: () => 'gnome_libsecret',
  },
  'linux',
)

describe('Microsoft sign-in privacy (GDPR-10, GDPR-06)', () => {
  it('refuses to sign in without consent, in strict mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-authp-'))
    dirs.push(dir)
    setPrivacySource(() => ({ ...DEFAULT_SETTINGS, gdprStrictMode: true, consents: {} }))
    const openBrowser = vi.fn()
    const auth = createAuthService({ clientId: 'id', cacheFile: join(dir, 'msal.bin'), openBrowser, fake: false, secrets: keyring })
    await expect(auth.signIn()).rejects.toBeInstanceOf(ConsentRequired)
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it('the fake auth is gated too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-authp-'))
    dirs.push(dir)
    setPrivacySource(() => ({ ...DEFAULT_SETTINGS, gdprStrictMode: true, consents: {} }))
    const auth = createAuthService({ clientId: 'id', cacheFile: join(dir, 'f'), openBrowser: vi.fn(), fake: true })
    await expect(auth.signIn()).rejects.toBeInstanceOf(ConsentRequired)
    consent('microsoftSignIn')
    await auth.signIn()
    expect((await auth.status()).signedIn).toBe(true)
  })

  it('strict mode asks for the import scopes only until OneDrive sync is allowed', async () => {
    expect(IMPORT_SCOPES).not.toContain('Files.ReadWrite.AppFolder')
    expect(SIGN_IN_SCOPES).toContain('Files.ReadWrite.AppFolder')
    for (const [granted, expected] of [[['microsoftSignIn'], IMPORT_SCOPES], [['microsoftSignIn', 'oneDriveSync'], SIGN_IN_SCOPES]] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'slate-authp-'))
      dirs.push(dir)
      consent(...granted)
      const openBrowser = vi.fn()
      const auth = createAuthService({ clientId: 'id', cacheFile: join(dir, 'msal.bin'), openBrowser, fake: false, secrets: keyring })
      // MSAL's real browser flow cannot finish here; the scopes sit in the URL it hands openBrowser.
      openBrowser.mockRejectedValue(new Error('stop'))
      await auth.signIn().catch(() => undefined)
      const url = String(openBrowser.mock.calls[0]?.[0] ?? '')
      const scope = new URL(url).searchParams.get('scope') ?? ''
      for (const s of expected) expect(scope).toContain(s)
      expect(scope.includes('Files.ReadWrite.AppFolder')).toBe(expected === SIGN_IN_SCOPES)
    }
  })

  it('sign-out deletes the cache file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-authp-'))
    dirs.push(dir)
    const file = join(dir, 'msal.bin')
    const store = secretFile(file, keyring)
    await encryptedCachePlugin(store).afterCacheAccess({ cacheHasChanged: true, tokenCache: { serialize: () => '{"Account":{}}' } } as never)
    expect(existsSync(file)).toBe(true)
    const auth = createAuthService({ clientId: 'id', cacheFile: file, openBrowser: vi.fn(), fake: false, secrets: keyring })
    await auth.signOut()
    expect(existsSync(file)).toBe(false)
  })
})

/**
 * Security review (v0.8): only the browser sign-in asked for microsoftSignIn, so after a withdrawal a silent refresh
 * still went to login.microsoftonline.com with the cached refresh token, and an import read Graph with it. Every
 * method that can reach Microsoft refuses without the consent, signed in or not.
 */
describe('every Microsoft auth method that reaches the network refuses without microsoftSignIn', () => {
  const signedInAccount = { homeAccountId: 'h', environment: 'login.microsoftonline.com', tenantId: 't', username: 'me@example.com', localAccountId: 'l' }
  const reaches: Record<string, (auth: AuthService) => Promise<unknown>> = {
    'signIn()': (auth) => auth.signIn(),
    'token() for an import': (auth) => auth.token(IMPORT_SCOPES),
    'token() for OneDrive sync': (auth) => auth.token(SIGN_IN_SCOPES),
  }

  /** The auth service's other methods, and why they reach nothing: with `reaches`, they must name every key it has. */
  const local: Record<string, string> = {
    status: "reads the accounts in MSAL's local token cache",
    signOut: 'removes the cached accounts and deletes the cache file on this computer',
  }

  it('reaches and its reasoned exceptions name every method the auth service has, so a new one cannot be missed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-authp-'))
    dirs.push(dir)
    const keys = Object.keys(createAuthService({ clientId: 'id', cacheFile: join(dir, 'msal.bin'), openBrowser: vi.fn(), fake: false, secrets: keyring })).sort()
    const named = new Set([...Object.keys(reaches).map((r) => r.slice(0, r.indexOf('('))), ...Object.keys(local)])
    expect(keys.filter((k) => !named.has(k)).map((k) => `auth.${k}: add a row to reaches calling it with microsoftSignIn withdrawn, or a reason in local`)).toEqual([])
    expect([...named].filter((k) => !keys.includes(k))).toEqual([])
  })

  it.each(Object.entries(reaches))('%s, signed in, after the consent was withdrawn', async (name, reach) => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-authp-'))
    dirs.push(dir)
    const silent = vi.spyOn(PublicClientApplication.prototype, 'acquireTokenSilent').mockResolvedValue({ accessToken: 'refreshed' } as never)
    const cache = vi.spyOn(PublicClientApplication.prototype, 'getTokenCache').mockReturnValue({ getAllAccounts: async () => [signedInAccount] } as never)
    try {
      setPrivacySource(() => ({ ...DEFAULT_SETTINGS, gdprStrictMode: true, consents: {} }))
      const openBrowser = vi.fn()
      const auth = createAuthService({ clientId: 'id', cacheFile: join(dir, 'msal.bin'), openBrowser, fake: false, secrets: keyring })
      await expect(reach(auth), name).rejects.toMatchObject({ name: 'ConsentRequired', feature: 'microsoftSignIn' })
      expect(silent, `${name} refreshed the token silently`).not.toHaveBeenCalled()
      expect(openBrowser).not.toHaveBeenCalled()
      // Granted again, the silent refresh is what token() uses.
      consent('microsoftSignIn')
      if (name.startsWith('token')) expect(await reach(auth)).toBe('refreshed')
    } finally {
      silent.mockRestore()
      cache.mockRestore()
    }
  })
})
