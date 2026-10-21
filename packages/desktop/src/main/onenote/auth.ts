import { PublicClientApplication, type AccountInfo, type ICachePlugin } from '@azure/msal-node'
import { safeStorage as electronSafeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface AuthStatus {
  configured: boolean
  signedIn: boolean
  account?: string
}

export interface AuthService {
  status(): Promise<AuthStatus>
  signIn(): Promise<void>
  signOut(): Promise<void>
  token(scopes: string[]): Promise<string>
}

/** The subset of Electron's safeStorage the token cache needs; tests pass a fake. */
export interface SecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

// Phase 4 sync needs the app folder too; asking for it now spares a second consent prompt.
export const SIGN_IN_SCOPES = ['Notes.Read', 'Files.ReadWrite.AppFolder', 'User.Read', 'offline_access']
const AUTHORITY = 'https://login.microsoftonline.com/common'
const SUCCESS_TEMPLATE = '<h1>Signed in to Slate. You can close this tab.</h1>'

/** MSAL cache persistence in one file, encrypted with the OS keychain when it is available. */
export function encryptedCachePlugin(file: string, storage: SecretStorage, warn: (msg: string) => void = console.warn): ICachePlugin {
  const encrypt = storage.isEncryptionAvailable()
  if (!encrypt) warn('safeStorage is unavailable; the Microsoft token cache is stored unencrypted')
  return {
    async beforeCacheAccess(ctx) {
      if (!existsSync(file)) return
      const raw = readFileSync(file)
      try {
        ctx.tokenCache.deserialize(encrypt ? storage.decryptString(raw) : raw.toString('utf8'))
      } catch {
        // An unreadable cache (keychain reset, corrupt file) just means signing in again.
      }
    },
    async afterCacheAccess(ctx) {
      if (!ctx.cacheHasChanged) return
      const json = ctx.tokenCache.serialize()
      writeFileSync(`${file}.tmp`, encrypt ? storage.encryptString(json) : Buffer.from(json, 'utf8'))
      renameSync(`${file}.tmp`, file)
    },
  }
}

function fakeAuth(): AuthService {
  let signedIn = false
  return {
    status: async () => ({ configured: true, signedIn, ...(signedIn ? { account: 'test@example.com' } : {}) }),
    signIn: async () => void (signedIn = true),
    signOut: async () => void (signedIn = false),
    token: async () => {
      if (!signedIn) throw new Error('not signed in')
      return 'fake-token'
    },
  }
}

export function createAuthService(opts: {
  clientId: string | null
  cacheFile: string
  openBrowser: (url: string) => Promise<void>
  fake: boolean
  storage?: SecretStorage
}): AuthService {
  if (opts.fake) return fakeAuth()
  let pca: PublicClientApplication | null = null
  const client = (): PublicClientApplication => {
    if (!opts.clientId) throw new Error('No Microsoft client id is configured')
    pca ??= new PublicClientApplication({
      auth: { clientId: opts.clientId, authority: AUTHORITY },
      cache: { cachePlugin: encryptedCachePlugin(opts.cacheFile, opts.storage ?? electronSafeStorage) },
    })
    return pca
  }
  const account = async (): Promise<AccountInfo | undefined> => (await client().getTokenCache().getAllAccounts())[0]
  const interactive = async (scopes: string[]): Promise<string> =>
    (await client().acquireTokenInteractive({ scopes, openBrowser: opts.openBrowser, successTemplate: SUCCESS_TEMPLATE })).accessToken

  return {
    async status() {
      if (!opts.clientId) return { configured: false, signedIn: false }
      const a = await account()
      return { configured: true, signedIn: !!a, ...(a ? { account: a.username } : {}) }
    },
    async signIn() {
      await interactive(SIGN_IN_SCOPES)
    },
    async signOut() {
      const cache = client().getTokenCache()
      for (const a of await cache.getAllAccounts()) await cache.removeAccount(a)
    },
    async token(scopes) {
      const a = await account()
      if (a) {
        try {
          return (await client().acquireTokenSilent({ account: a, scopes })).accessToken
        } catch {
          // Expired refresh token or new scopes: fall through to the browser.
        }
      }
      return interactive(scopes)
    },
  }
}
