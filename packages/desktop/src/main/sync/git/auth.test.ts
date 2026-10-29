import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeGitRunner, tokenEnv, type GitResult, type GitRunner, type GitRunOptions } from '@slate/sync'
import { Logger } from '../../log/logger'
import { createSecretStorage, secretFile } from '../../secretStorage'
import { createPrivateRepo, githubDeviceFlow, testConnection } from './auth'

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

const KEX = join(dirname(fileURLToPath(import.meta.url)), '../../../../../sync/test/fixtures/kex')
const fixture = (name: string) => readFileSync(join(KEX, name), 'utf8')
const SECRET_B64 = 'eC1hY2Nlc3MtdG9rZW46Z2hwX1NFQ1JFVFRPS0VOMTIzNDU2'

/** A runner that answers once with `result` and keeps the call it saw. */
function fakeRunner(result: Partial<GitResult>) {
  const calls: { args: string[]; opts?: GitRunOptions }[] = []
  const run: GitRunner = async (args, opts) => {
    calls.push({ args, opts })
    return { code: 0, stdout: new Uint8Array(), stderr: '', ...result }
  }
  return { run, calls }
}

describe('testConnection observes the key exchange (PQ-C2)', () => {
  it('reads the ssh kex from a -v run, on the sshCommand-built command, and names the host', async () => {
    const { run, calls } = fakeRunner({ stderr: fixture('openssh-10.3.txt'), stdout: new Uint8Array([1]) })
    const cmd = 'ssh -o BatchMode=yes -o KexAlgorithms=^mlkem768x25519-sha256'
    const r = await testConnection(run, 'git@github.com:o/r.git', {}, { sshCommand: cmd })
    expect(r).toMatchObject({ ok: true, message: 'Connected.', kex: 'mlkem768x25519-sha256', pq: 'hybrid', remote: 'git-ssh:github.com' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts?.env?.GIT_SSH_COMMAND).toBe(`${cmd} -v`)
  })

  it('refuses -v on a command sshCommand did not build', async () => {
    const { run, calls } = fakeRunner({})
    const r = await testConnection(run, 'git@github.com:o/r.git', {}, { sshCommand: 'ssh -o ProxyCommand=evil' })
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reads the TLS group from a curl trace over https, and reports unknown when the backend prints none', async () => {
    const hybrid = await testConnection(fakeRunner({ stderr: fixture('curl-openssl-3.5.txt') }).run, 'https://github.com/o/r.git', {})
    expect(hybrid).toMatchObject({ ok: true, kex: 'X25519MLKEM768', pq: 'hybrid', remote: 'git-https:github.com' })
    const { run, calls } = fakeRunner({ stderr: fixture('curl-securetransport.txt') })
    const unknown = await testConnection(run, 'https://github.com/o/r.git', {})
    expect(unknown).toMatchObject({ ok: true, kex: null, pq: 'unknown', remote: 'git-https:github.com' })
    expect(calls[0]!.opts?.env).toMatchObject({ GIT_TRACE_CURL: '1', GIT_TRACE_REDACT: '1' })
  })

  it('a local path records nothing', async () => {
    const r = await testConnection(fakeRunner({}).run, 'file:///tmp/r.git', {})
    expect(r).toEqual({ ok: true, message: 'Connected. The repository is empty; Slate will set it up.' })
  })

  it('T-PQ-C2-03: the -v debug lines are not signed-out or offline to the sync engine', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../sync/src/gitDrive.ts'), 'utf8')
    const pattern = (name: string) => {
      const m = new RegExp(`const ${name} = /(.+)/i`).exec(src)
      if (!m) throw new Error(`${name} not found in gitDrive.ts`)
      return new RegExp(m[1]!, 'i')
    }
    for (const file of ['openssh-8.9.txt', 'openssh-9.6.txt', 'openssh-10.3.txt', 'openssh-classical.txt', 'curl-openssl-3.5.txt', 'curl-securetransport.txt']) {
      expect(pattern('SIGNED_OUT').test(fixture(file)), file).toBe(false)
      expect(pattern('OFFLINE').test(fixture(file)), file).toBe(false)
    }
  })

  it('T-PQ-C2-04: an Authorization header in a trace never reaches the logger or the result', async () => {
    const spy = vi.spyOn(Logger.prototype, 'log')
    try {
      const trace = fixture('curl-openssl-3.5.txt')
      expect(trace).toContain(SECRET_B64)
      for (const result of [{ stderr: trace }, { code: 128, stderr: `${trace}fatal: Authentication failed for 'https://github.com/o/r.git/'\n` }, { code: 128, stderr: trace }]) {
        const env = tokenEnv('ghp_SECRETTOKEN123456')
        const r = await testConnection(fakeRunner(result).run, 'https://github.com/o/r.git', env)
        const out = JSON.stringify(r)
        expect(out).not.toContain(SECRET_B64)
        expect(out).not.toMatch(/Authorization|basic |SECRETTOKEN/i)
      }
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET_B64)
      expect(spy.mock.calls).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('the git token file (src/main/secretStorage.ts)', () => {
  const storage = (backend: 'gnome_libsecret' | 'basic_text' = 'gnome_libsecret') =>
    createSecretStorage(
      {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (s: string) => Buffer.from(`enc:${s}`),
        decryptStringAsync: async (b: Buffer) => ({ result: b.toString().slice(4), shouldReEncrypt: false }),
        getSelectedStorageBackend: () => backend,
      },
      'linux',
    )

  it('keeps the token encrypted on disk', async () => {
    const file = join(temp(), 'token.bin')
    const secret = secretFile(file, storage())
    expect(await secret.get()).toBeUndefined()
    await secret.set('ghp_x')
    expect(readFileSync(file, 'utf8')).toBe('enc:ghp_x')
    expect(await secret.get()).toBe('ghp_x')
    await secret.clear()
    expect(await secret.get()).toBeUndefined()
  })

  it('never writes a token without a real keyring (basic_text): it lasts this session only', async () => {
    const file = join(temp(), 't.bin')
    const secret = secretFile(file, storage('basic_text'))
    await secret.set('ghp_x')
    expect(existsSync(file)).toBe(false)
    expect(await secret.get()).toBe('ghp_x')
  })
})
