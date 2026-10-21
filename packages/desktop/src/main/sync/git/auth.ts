import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { NETWORK_TIMEOUT_MS, type GitRunner } from '@slate/sync'
import type { DeviceCode, GitCheck } from '../../../shared/api'
import type { SecretStorage } from '../../onenote/auth'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const REPOS_URL = 'https://api.github.com/user/repos'
const GH_TIMEOUT_MS = 10_000

const signedOut = (message: string) => Object.assign(new Error(message), { status: 401 })

/** One token in one file, encrypted with the OS keychain; never stored in plain text. */
export function secretFile(file: string, storage: SecretStorage) {
  return {
    get(): string | undefined {
      if (!existsSync(file) || !storage.isEncryptionAvailable()) return undefined
      try {
        return storage.decryptString(readFileSync(file)) || undefined
      } catch {
        // A keychain reset makes the file unreadable: sign in again.
        return undefined
      }
    },
    set(token: string): void {
      if (!storage.isEncryptionAvailable()) throw new Error('This computer cannot encrypt the token, so Slate will not store it')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, storage.encryptString(token), { mode: 0o600 })
    },
    clear(): void {
      rmSync(file, { force: true })
    },
  }
}

export type SecretFile = ReturnType<typeof secretFile>

/** The GitHub CLI's current token, read fresh each time and never stored. */
export function ghToken(ghPath = 'gh'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ghPath, ['auth', 'token'], { timeout: GH_TIMEOUT_MS, shell: false, windowsHide: true }, (err, stdout) => {
      const token = String(stdout).trim()
      if (err || !token) reject(signedOut('The GitHub CLI is not signed in: run `gh auth login`'))
      else resolve(token)
    })
  })
}

interface DeviceFlowDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

async function postForm(doFetch: typeof fetch, url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

/**
 * GitHub's OAuth device flow (docs.github.com, "Authorizing OAuth apps": device flow): shows the
 * user a code to enter at github.com/login/device, then polls until they approve it.
 */
export async function githubDeviceFlow(clientId: string, onCode: (code: DeviceCode) => void, deps: DeviceFlowDeps = {}): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const code = await postForm(doFetch, DEVICE_CODE_URL, { client_id: clientId, scope: 'repo' })
  if (typeof code.device_code !== 'string') throw new Error(`GitHub did not start the sign-in: ${String(code.error_description ?? code.error ?? 'no code')}`)
  onCode({ userCode: String(code.user_code), verificationUri: String(code.verification_uri) })
  let interval = Number(code.interval ?? 5)
  const deadline = now() + Number(code.expires_in ?? 900) * 1000
  for (;;) {
    await sleep(interval * 1000)
    if (now() >= deadline) throw new Error('The sign-in code expired; start again')
    const answer = await postForm(doFetch, ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: code.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (typeof answer.access_token === 'string') return answer.access_token
    if (answer.error === 'authorization_pending') continue
    // GitHub asks for a longer interval and says which; the spec says add 5 s otherwise.
    if (answer.error === 'slow_down') interval = Number(answer.interval ?? interval + 5)
    else if (answer.error === 'expired_token') throw new Error('The sign-in code expired; start again')
    else if (answer.error === 'access_denied') throw new Error('Sign-in was denied on GitHub')
    else throw new Error(`GitHub sign-in failed: ${String(answer.error_description ?? answer.error)}`)
  }
}

/** A new private, empty repository on the token owner's account. */
export async function createPrivateRepo(token: string, name: string, doFetch: typeof fetch = fetch): Promise<GitCheck> {
  try {
    const res = await doFetch(REPOS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: true, auto_init: false }),
    })
    const body = (await res.json()) as { clone_url?: string; message?: string; errors?: { message?: string }[] }
    if (!res.ok || !body.clone_url) return { ok: false, message: body.errors?.[0]?.message ?? body.message ?? `GitHub answered ${res.status}` }
    const owner = new URL(body.clone_url).pathname.replace(/^\//, '').replace(/\.git$/, '')
    return { ok: true, message: `Created ${owner}`, url: body.clone_url }
  } catch (err) {
    return { ok: false, message: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** `git ls-remote` with the auth env: proves the URL and the credentials before saving. */
export async function testConnection(run: GitRunner, url: string, env: Record<string, string>): Promise<GitCheck> {
  try {
    const r = await run(['ls-remote', '--heads', url], { env, timeoutMs: NETWORK_TIMEOUT_MS })
    if (r.code === 0) return { ok: true, message: r.stdout.length === 0 ? 'Connected. The repository is empty; Slate will set it up.' : 'Connected.' }
    const lines = r.stderr.trim().split('\n').filter(Boolean)
    return { ok: false, message: r.timedOut ? 'Timed out reaching the repository' : (lines.find((l) => l.startsWith('fatal:'))?.replace(/^fatal:\s*/, '') ?? lines.pop() ?? `git exited with ${r.code}`) }
  } catch (err) {
    return { ok: false, message: `Could not run git: ${err instanceof Error ? err.message : String(err)}` }
  }
}
