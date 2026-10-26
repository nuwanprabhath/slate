import { PublicClientApplication, type AccountInfo, type ICachePlugin } from '@azure/msal-node'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { appSecretStorage, secretFile, type SecretFile, type SecretStorage } from '../secretStorage'

export interface AuthStatus {
  configured: boolean
  signedIn: boolean
  account?: string
  /** False when this computer has no keyring: the sign-in lasts until Slate quits. */
  remembered?: boolean
}

export interface AuthService {
  status(): Promise<AuthStatus>
  signIn(): Promise<void>
  signOut(): Promise<void>
  token(scopes: string[]): Promise<string>
}

// Phase 4 sync needs the app folder too; asking for it now spares a second consent prompt.
export const SIGN_IN_SCOPES = ['Notes.Read', 'Files.ReadWrite.AppFolder', 'User.Read', 'offline_access']
const AUTHORITY = 'https://login.microsoftonline.com/common'
const SUCCESS_TEMPLATE = '<h1>Signed in to Slate. You can close this tab.</h1>'

/**
 * MSAL cache persistence, sealed by the OS keyring (src/main/secretStorage.ts). Without a keyring
 * the tokens stay in memory and the user signs in again after a restart (B-5: never in plain text).
 */
export function encryptedCachePlugin(store: SecretFile): ICachePlugin {
  return {
    async beforeCacheAccess(ctx) {
      const json = await store.get()
      if (json === undefined) return
      try {
        ctx.tokenCache.deserialize(json)
      } catch {
        // An unreadable cache (keychain reset, corrupt file) just means signing in again.
      }
    },
    async afterCacheAccess(ctx) {
      if (!ctx.cacheHasChanged) return
      await store.set(ctx.tokenCache.serialize())
    },
  }
}

/** Keeps its sign-in in `cacheFile`, as MSAL does, so a relaunched e2e app is still signed in. */
function fakeAuth(cacheFile: string): AuthService {
  let signedIn = existsSync(cacheFile) && readFileSync(cacheFile, 'utf8') === 'fake-signed-in'
  const save = (value: boolean) => {
    signedIn = value
    writeFileSync(cacheFile, value ? 'fake-signed-in' : '')
  }
  return {
    status: async () => ({ configured: true, signedIn, ...(signedIn ? { account: 'test@example.com' } : {}) }),
    signIn: async () => save(true),
    signOut: async () => save(false),
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
  /** The OS keyring; Electron's by default. */
  secrets?: SecretStorage
}): AuthService {
  if (opts.fake) return fakeAuth(opts.cacheFile)
  const store = secretFile(opts.cacheFile, opts.secrets ?? appSecretStorage())
  let pca: PublicClientApplication | null = null
  const client = (): PublicClientApplication => {
    if (!opts.clientId) throw new Error('No Microsoft client id is configured')
    pca ??= new PublicClientApplication({
      auth: { clientId: opts.clientId, authority: AUTHORITY },
      cache: { cachePlugin: encryptedCachePlugin(store) },
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
      return { configured: true, signedIn: !!a, ...(a ? { account: a.username } : {}), remembered: await store.persistent() }
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
