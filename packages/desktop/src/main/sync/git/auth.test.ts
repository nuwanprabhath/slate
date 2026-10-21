import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeGitRunner } from '@slate/sync'
import { createPrivateRepo, githubDeviceFlow, secretFile, testConnection } from './auth'

const dirs: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-git-auth-'))
  dirs.push(dir)
  return dir
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

interface Call {
  url: string
  body: Record<string, string>
  headers: Record<string, string>
}

/** A fetch that answers each call with the next queued JSON body. */
function scripted(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body ?? '{}')), headers: init.headers as Record<string, string> })
    const next = responses.shift()
    if (!next) throw new Error('unexpected call')
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const CODE = { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }

describe('githubDeviceFlow', () => {
  it('shows the code, waits while pending, slows down when told, and returns the token', async () => {
    const { fetch, calls } = scripted([
      { body: CODE },
      { body: { error: 'authorization_pending' } },
      { body: { error: 'slow_down', interval: 10 } },
      { body: { access_token: 'gho_token', token_type: 'bearer' } }
    ])
    const sleeps: number[] = []
    const shown: string[] = []
    const token = await githubDeviceFlow('client-1', (c) => shown.push(`${c.userCode} ${c.verificationUri}`), {
      fetch,
      sleep: async (ms) => void sleeps.push(ms)
    })
    expect(token).toBe('gho_token')
    expect(shown).toEqual(['ABCD-1234 https://github.com/login/device'])
    expect(sleeps).toEqual([5000, 5000, 10000])
    expect(calls[0]).toMatchObject({ url: 'https://github.com/login/device/code', body: { client_id: 'client-1', scope: 'repo' } })
    expect(calls[1]).toMatchObject({
      url: 'https://github.com/login/oauth/access_token',
      body: { client_id: 'client-1', device_code: 'dc', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }
    })
    expect(calls[1]!.headers.Accept).toBe('application/json')
  })

  it('fails when the user denies or the code expires', async () => {
    const denied = scripted([{ body: CODE }, { body: { error: 'access_denied' } }])
    await expect(githubDeviceFlow('c', () => {}, { fetch: denied.fetch, sleep: async () => {} })).rejects.toThrow(/denied/)
    let now = 0
    const pending = scripted([{ body: { ...CODE, expires_in: 10 } }, ...Array.from({ length: 5 }, () => ({ body: { error: 'authorization_pending' } }))])
    await expect(
      githubDeviceFlow('c', () => {}, { fetch: pending.fetch, sleep: async (ms) => void (now += ms), now: () => now })
    ).rejects.toThrow(/expired/)
  })
})

describe('createPrivateRepo', () => {
  it('creates a private, empty repository with the token', async () => {
    const { fetch, calls } = scripted([{ status: 201, body: { clone_url: 'https://github.com/me/notes.git', ssh_url: 'git@github.com:me/notes.git' } }])
    expect(await createPrivateRepo('tok', 'notes', fetch)).toEqual({ ok: true, message: 'Created me/notes', url: 'https://github.com/me/notes.git' })
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/user/repos', body: { name: 'notes', private: true, auto_init: false } })
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok')
  })

  it('explains a failure', async () => {
    const { fetch } = scripted([{ status: 422, body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] } }])
    expect(await createPrivateRepo('tok', 'notes', fetch)).toEqual({ ok: false, message: 'name already exists on this account' })
  })
})

describe('testConnection', () => {
  it('reaches a bare repo and explains one that does not exist', async () => {
    const bare = join(temp(), 'r.git')
    execFileSync('git', ['init', '--bare', bare])
    const run = nodeGitRunner()
    expect(await testConnection(run, `file://${bare}`, {})).toMatchObject({ ok: true })
    const missing = await testConnection(run, 'file:///does/not/exist', {})
    expect(missing.ok).toBe(false)
    expect(missing.message).toMatch(/does not appear to be a git repository|not found|Could not read/i)
  })
})

describe('secretFile', () => {
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice(4)
  }

  it('keeps the token encrypted on disk', () => {
    const file = join(temp(), 'token.bin')
    const secret = secretFile(file, storage)
    expect(secret.get()).toBeUndefined()
    secret.set('ghp_x')
    expect(readFileSync(file, 'utf8')).toBe('enc:ghp_x')
    expect(secret.get()).toBe('ghp_x')
    secret.clear()
    expect(secret.get()).toBeUndefined()
  })

  it('refuses to store a token without encryption', () => {
    const secret = secretFile(join(temp(), 't.bin'), { ...storage, isEncryptionAvailable: () => false })
    expect(() => secret.set('ghp_x')).toThrow(/encrypt/)
  })
})
