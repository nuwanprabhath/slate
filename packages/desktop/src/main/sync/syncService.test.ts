import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEDULE_V1 } from '../vault/suite'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotebookDoc, PageDoc } from '@slate/core'
import { nodeGitRunner, parseRemotePath, type GitRunner, type NodeGitRunnerOptions, type SshKexProbe } from '@slate/sync'
import { startFakeDrive, type FakeDrive } from '../../../../sync/test/fakeDrive'
import { addTextBox, boxText } from '../../../../sync/test/memoryLocal'
import type { GitAuthMode, SyncState } from '../../shared/api'
import { FileBlobStore, type BlobStore } from '../blobs'
import { createAuthService } from '../onenote/auth'
import { writeSettings } from '../settings'
import { DocStore } from '../store'
import { importKey } from '../../../test/vaultKeys'
import { KeyRing } from '../vault/keyring'
import { SyncService } from './syncService'

const PAGE = 'page:11111111-1111-4111-8111-111111111111'

interface Device {
  store: DocStore
  blobs: BlobStore
  service: SyncService
  states: SyncState[]
  notices: string[]
  opened: string[]
}

const secrets = {
  available: async () => true,
  seal: async (s: string) => Buffer.from(`enc:${s}`),
  open: async (b: Buffer) => ({ plain: b.toString().slice(4), rewrite: false }),
}

let dir: string
let drive: FakeDrive
const devices: Device[] = []

interface DeviceOptions {
  enabled?: boolean
  signedIn?: boolean
  keyRing?: KeyRing
  intervalMs?: number
  graphUrl?: string
  gitRunner?: (opts: NodeGitRunnerOptions) => GitRunner
  probeSsh?: () => Promise<SshKexProbe>
}

async function device(name: string, opts: DeviceOptions = {}): Promise<Device> {
  const dbFile = join(dir, `${name}.db`)
  const store = new DocStore(dbFile)
  const blobs = new FileBlobStore(join(dir, `${name}-blobs`))
  const auth = createAuthService({ clientId: null, cacheFile: join(dir, `${name}.bin`), openBrowser: async () => {}, fake: true })
  if (opts.signedIn !== false) await auth.signIn()
  const states: SyncState[] = []
  const notices: string[] = []
  const opened: string[] = []
  const service = new SyncService({
    dbFile,
    blobs,
    auth,
    graphUrl: opts.graphUrl ?? drive.url,
    gitDir: join(dir, `${name}-git`),
    secrets,
    deviceName: name,
    intervalMs: opts.intervalMs ?? 0,
    emitStatus: (s) => states.push(s),
    emitNotice: (m) => notices.push(m),
    emitOpenNotebook: (id) => opened.push(id),
    keyRing: opts.keyRing,
    ...(opts.gitRunner ? { gitRunner: opts.gitRunner } : {}),
    ...(opts.probeSsh ? { probeSsh: opts.probeSsh } : {}),
  })
  // setEnabled signs in when needed, so a signed-out device has the setting written directly.
  if (opts.enabled !== false && opts.signedIn === false) writeSettings(store, { syncProvider: 'onedrive' })
  else if (opts.enabled !== false) await service.setEnabled(true)
  const d = { store, blobs, service, states, notices, opened }
  devices.push(d)
  return d
}

function writePage(store: DocStore, text: string): string {
  const page = new PageDoc()
  const id = addTextBox(page, text)
  store.append(PAGE, page.doc.export({ mode: 'update' }))
  return id
}

const uploadsFor = (deviceId: string) =>
  [...drive.files.keys()].filter((p) => {
    const parsed = parseRemotePath(p)
    return parsed.kind === 'chunk' && parsed.deviceId === deviceId
  })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'slate-sync-'))
  drive = await startFakeDrive()
})

afterEach(async () => {
  for (const d of devices.splice(0)) {
    d.service.close()
    d.store.close()
  }
  await drive.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SyncService', () => {
  it('waits a full interval after a sync ends before the timer starts the next, however long the sync took', async () => {
    const interval = 100
    const a = await device('A', { intervalMs: interval })
    const spans: Array<{ start: number; end: number }> = []
    const inner = a.service as unknown as { run: () => Promise<unknown> }
    const run = inner.run.bind(a.service)
    // Each sync outlasts two ticks, as a git sync does under the e2e's 500 ms interval.
    inner.run = async () => {
      const span = { start: Date.now(), end: 0 }
      spans.push(span)
      try {
        return await run()
      } finally {
        await new Promise((r) => setTimeout(r, interval * 2.5))
        span.end = Date.now()
      }
    }
    a.service.start()
    await new Promise((r) => setTimeout(r, interval * 12))
    await a.service.stop()
    const done = spans.filter((s) => s.end > 0)
    expect(done.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < done.length; i++) expect(done[i]!.start - done[i - 1]!.end).toBeGreaterThanOrEqual(interval - 5)
  })

  it('T-PQ-B2-01: after one sync this device record carries pq 1 and still epochs 1', async () => {
    const a = await device('A')
    expect((await a.service.now()).status).toBe('idle-synced')
    const records = await a.service.deviceRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ name: 'A', epochs: 1, pq: 1 })
  })

  it('T-PQ-B2-03: a second sync with no change writes no new device record', async () => {
    const a = await device('A')
    await a.service.now()
    const path = [...drive.files.keys()].find((p) => /^devices\/[^/]+\.json$/.test(p))!
    expect(path).toBeDefined()
    const first = drive.files.get(path)!
    await a.service.now()
    expect(drive.files.get(path)).toBe(first)
  })

  it('delivers a page from A into B as remote updates and never uploads them back', async () => {
    const a = await device('A')
    const b = await device('B')
    const boxId = writePage(a.store, 'hello from A')
    expect((await a.service.now()).status).toBe('idle-synced')
    expect((await b.service.now()).status).toBe('idle-synced')

    expect(boxText(PageDoc.fromUpdates(b.store.load(PAGE)), boxId)).toBe('hello from A')
    expect(b.store.origins(PAGE)).toContain('remote')
    expect(uploadsFor(a.service.deviceId)).toHaveLength(1)
    expect(uploadsFor(b.service.deviceId)).toHaveLength(0)
    await b.service.now()
    expect(uploadsFor(b.service.deviceId)).toHaveLength(0)
  })

  it('reports syncing then idle-synced, with the account', async () => {
    const a = await device('A')
    a.states.length = 0
    await a.service.now()
    expect(a.states.map((s) => s.status)).toEqual(['syncing', 'idle-synced'])
    const status = await a.service.status()
    expect(status).toMatchObject({ status: 'idle-synced', enabled: true, account: 'test@example.com' })
    expect(status.lastSyncedAt).toBeTypeOf('number')
  })

  it('reports offline when the drive is unreachable, and recovers', async () => {
    const a = await device('A')
    drive.offline(true)
    expect((await a.service.now()).status).toBe('offline')
    expect((await a.service.status()).status).toBe('offline')
    drive.offline(false)
    expect((await a.service.now()).status).toBe('idle-synced')
  })

  it('touches nothing while disabled or signed out', async () => {
    const off = await device('A', { enabled: false })
    writePage(off.store, 'x')
    expect((await off.service.now()).status).toBe('disabled')
    const out = await device('B', { signedIn: false })
    expect((await out.service.now()).status).toBe('signed-out')
    expect(drive.files.size).toBe(0)
  })

  it('fetches a blob another device pushed when it is missing here', async () => {
    const a = await device('A')
    const b = await device('B')
    const url = a.blobs.put(new Uint8Array([1, 2, 3]), 'image/png')
    const name = url.split('/').pop()!
    await a.service.now()
    expect(b.blobs.has(name)).toBe(false)
    expect(await b.service.ensureBlob(name)).toBe(true)
    expect([...b.blobs.read(name)]).toEqual([1, 2, 3])
  })

  it('resolves a conflict by rewriting the box with the chosen side', async () => {
    const a = await device('A')
    const boxId = writePage(a.store, 'merged text')
    a.store.addConflict({ id: 'c1', pageId: PAGE, boxId, device: 'B', mine: 'mine text', theirs: 'their text', merged: 'merged text', at: 1 })
    await a.service.resolve('c1', 'theirs')
    expect(boxText(PageDoc.fromUpdates(a.store.load(PAGE)), boxId)).toBe('their text')
    expect(await a.service.conflicts(PAGE)).toEqual([])
  })

  it('with a key ring, writes only e2ee files and still delivers pages and blobs', async () => {
    const mk = Buffer.alloc(32, 7)
    const a = await device('A', { keyRing: new KeyRing(importKey(mk, 'master'), undefined, SCHEDULE_V1) })
    const b = await device('B', { keyRing: new KeyRing(importKey(mk, 'master'), undefined, SCHEDULE_V1) })
    const boxId = writePage(a.store, 'sealed from A')
    const name = a.blobs.put(new Uint8Array([4, 5, 6]), 'image/png').split('/').pop()!
    expect((await a.service.now()).status).toBe('idle-synced')
    expect((await b.service.now()).status).toBe('idle-synced')
    expect(boxText(PageDoc.fromUpdates(b.store.load(PAGE)), boxId)).toBe('sealed from A')
    expect(await b.service.ensureBlob(name)).toBe(true)
    expect([...b.blobs.read(name)]).toEqual([4, 5, 6])
    expect([...drive.files.keys()].every((p) => p.startsWith('e2ee/'))).toBe(true)
  })

  it('stop() abandons a download that never finishes instead of waiting for it', async () => {
    const a = await device('A')
    const b = await device('B')
    writePage(a.store, 'from A')
    await a.service.now()
    const realFetch = globalThis.fetch
    let hung = false
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(':/content') && (init?.method ?? 'GET') === 'GET') {
        hung = true
        return new Promise<Response>(() => {})
      }
      return realFetch(input, init)
    }) as typeof fetch
    try {
      const syncing = b.service.now()
      await expect.poll(() => hung).toBe(true)
      const started = Date.now()
      await b.service.stop()
      expect(Date.now() - started).toBeLessThan(1000)
      // Quiet: the abandoned run is no error, and nothing was recorded as pulled.
      expect((await syncing).status).not.toBe('error')
      expect(b.states.map((s) => s.status)).not.toContain('error')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('SyncService over git', { timeout: 30_000 }, () => {
  let bare: string
  const gitSettings = (auth: GitAuthMode = 'system') => ({ remoteUrl: `file://${bare}`, branch: 'main', auth })

  beforeEach(() => {
    bare = join(dir, 'remote.git')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare])
  })

  const gitLog = () => execFileSync('git', ['--git-dir', bare, 'log', '--format=%an|%s', 'main']).toString()

  it('delivers a page from A to B through the repository', async () => {
    const a = await device('A', { enabled: false })
    const b = await device('B', { enabled: false })
    await a.service.configure({ provider: 'git', git: gitSettings() })
    await b.service.configure({ provider: 'git', git: gitSettings() })
    const boxId = writePage(a.store, 'hello over git')
    expect((await a.service.now()).status).toBe('idle-synced')
    expect((await b.service.now()).status).toBe('idle-synced')
    expect(boxText(PageDoc.fromUpdates(b.store.load(PAGE)), boxId)).toBe('hello over git')
    expect(await a.service.status()).toMatchObject({ provider: 'git', enabled: true, remote: `file://${bare}` })
    expect(gitLog()).toMatch(/Slate \(A\)\|slate: A \(\d+ files?\)/)
    expect(gitLog()).toContain('Slate (B)')
    expect(drive.files.size).toBe(0)
  })

  it('shows a plaintext device whose remote was replaced by an encrypted orphan as join-needed', async () => {
    const a = await device('A', { enabled: false })
    await a.service.configure({ provider: 'git', git: gitSettings() })
    writePage(a.store, 'plaintext')
    expect((await a.service.now()).status).toBe('idle-synced')
    const g = (args: string[], input?: string) => execFileSync('git', ['--git-dir', bare, ...args], input === undefined ? {} : { input }).toString().trim()
    const vault = g(['mktree', '-z'], `100644 blob ${g(['hash-object', '-w', '--stdin'], '{}')}\tvault.json\0`)
    const orphan = g(['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', g(['mktree', '-z'], `040000 tree ${vault}\te2ee\0`), '-m', 'slate: encrypted'])
    g(['update-ref', 'refs/heads/main', orphan])
    writePage(a.store, 'more plaintext')
    expect((await a.service.now()).status).toBe('error')
    expect(await a.service.status()).toMatchObject({ vaultProblem: 'join-needed' })
    expect(g(['rev-parse', 'main'])).toBe(orphan)
  })

  it('with a key ring, commits under a neutral author and message', async () => {
    const mk = Buffer.alloc(32, 9)
    const a = await device('A', { enabled: false, keyRing: new KeyRing(importKey(mk, 'master'), undefined, SCHEDULE_V1) })
    const b = await device('B', { enabled: false, keyRing: new KeyRing(importKey(mk, 'master'), undefined, SCHEDULE_V1) })
    await a.service.configure({ provider: 'git', git: gitSettings() })
    await b.service.configure({ provider: 'git', git: gitSettings() })
    const boxId = writePage(a.store, 'sealed over git')
    expect((await a.service.now()).status).toBe('idle-synced')
    expect((await b.service.now()).status).toBe('idle-synced')
    expect(boxText(PageDoc.fromUpdates(b.store.load(PAGE)), boxId)).toBe('sealed over git')
    const lines = gitLog().trim().split('\n')
    expect(lines.every((l) => l === 'Slate|slate: sync' || l === 'Slate|slate: initialise')).toBe(true)
    const email = execFileSync('git', ['--git-dir', bare, 'log', '--format=%ae %ce', 'main']).toString()
    expect(email.trim().split('\n').every((l) => l === 'slate@invalid slate@invalid')).toBe(true)
  })

  it('is signed out in token mode until a token is saved, and keeps the token out of settings', async () => {
    const a = await device('A', { enabled: false })
    await a.service.configure({ provider: 'git', git: gitSettings('token') })
    expect((await a.service.now()).status).toBe('signed-out')
    await a.service.configure({ provider: 'git', git: gitSettings('token'), token: 'ghp_secret' })
    expect((await a.service.now()).status).toBe('idle-synced')
    expect(JSON.stringify(a.store.getSetting('settings'))).not.toContain('ghp_secret')
    expect(await a.service.gitAuthInfo()).toMatchObject({ hasToken: true, deviceFlow: false })
    const configs = readdirSync(join(dir, 'A-git'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('config'))
    for (const f of configs) expect(readFileSync(join(dir, 'A-git', f), 'utf8')).not.toMatch(/ghp_secret|extraheader/)
  })

  it('checks a connection before saving', async () => {
    const a = await device('A', { enabled: false })
    expect(await a.service.testGit(gitSettings())).toMatchObject({ ok: true })
    expect((await a.service.testGit({ ...gitSettings(), remoteUrl: 'file:///does/not/exist' })).ok).toBe(false)
  })

  it('turns off through configure', async () => {
    const a = await device('A', { enabled: false })
    await a.service.configure({ provider: 'git', git: gitSettings() })
    await a.service.configure({ provider: null })
    expect((await a.service.now()).status).toBe('disabled')
    expect(await a.service.status()).toMatchObject({ provider: null, enabled: false })
  })

  describe('the notebook to open after the first sync', () => {
    function writeNotebook(store: DocStore, id: string, text?: string): void {
      const nb = NotebookDoc.create(id)
      const { pageId } = nb.addPage(nb.addSection('S'))
      store.append(`notebook:${id}`, nb.doc.export({ mode: 'update' }))
      if (text === undefined) return
      const page = new PageDoc()
      addTextBox(page, text)
      store.append(`page:${pageId}`, page.doc.export({ mode: 'update' }))
    }

    async function other(): Promise<void> {
      const a = await device('A')
      writeNotebook(a.store, 'work', 'notes')
      a.service.recordOpen('work')
      await a.service.now()
    }

    it('opens the notebook another device has open instead of an empty default, on the first pull only', async () => {
      await other()
      const b = await device('B', { enabled: false })
      writeNotebook(b.store, 'default')
      b.service.recordOpen('default')
      await b.service.setEnabled(true)
      expect(b.opened).toEqual(['work'])
      await b.service.now()
      expect(b.opened).toEqual(['work'])
    })

    it('keeps a notebook that has content', async () => {
      await other()
      const b = await device('B', { enabled: false })
      writeNotebook(b.store, 'mine', 'my own')
      b.service.recordOpen('mine')
      await b.service.setEnabled(true)
      expect(b.opened).toEqual([])
    })

    it('records openings in the synced notebook doc, once per notebook in a while', async () => {
      const a = await device('A', { enabled: false })
      writeNotebook(a.store, 'work')
      a.service.recordOpen('work')
      const updates = a.store.load('notebook:work').length
      a.service.recordOpen('work')
      expect(a.store.load('notebook:work')).toHaveLength(updates)
      expect(Object.keys(NotebookDoc.fromUpdates(a.store.load('notebook:work')).openOn())).toEqual([a.service.deviceId])
    })
  })
})

describe('SyncService post-quantum transport policy (PQ-C4)', { timeout: 30_000 }, () => {
  const SSH_URL = 'ssh://git@pq.invalid/notes.git'
  const HTTPS_URL = 'https://pq.invalid/notes.git'
  const hybridSsh: SshKexProbe = { hybrid: ['mlkem768x25519-sha256'], ssh: 'OpenSSH_10.0', prepend: true }
  const PREFER = 'ssh -o BatchMode=yes -o KexAlgorithms=^mlkem768x25519-sha256'
  const REQUIRE = 'ssh -o BatchMode=yes -o KexAlgorithms=mlkem768x25519-sha256'
  const NETWORK = new Set(['fetch', 'push', 'ls-remote', 'clone', 'pull'])
  let bare: string

  interface Call {
    args: string[]
    ssh: string | undefined
  }

  beforeEach(() => {
    bare = join(dir, 'remote.git')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare])
  })

  const refs = () => execFileSync('git', ['--git-dir', bare, 'for-each-ref']).toString().trim()

  /**
   * Real git with the ssh URL rewritten to the local bare repository, so a whole sync runs; each call records the
   * GIT_SSH_COMMAND its runner was built with. `serverRefuses` answers network commands as an ssh server offering
   * no hybrid would.
   */
  function recordingRunner(calls: Call[], serverRefuses = false): (opts: NodeGitRunnerOptions) => GitRunner {
    return (runnerOpts) => {
      const real = nodeGitRunner('git', runnerOpts)
      return async (args, opts = {}) => {
        calls.push({ args, ssh: runnerOpts.sshCommand })
        if (serverRefuses && NETWORK.has(args[0]!)) {
          return {
            code: 128,
            stdout: new Uint8Array(),
            stderr: 'Unable to negotiate with 192.0.2.1 port 22: no matching key exchange method found. Their offer: curve25519-sha256\nfatal: Could not read from remote repository.\n',
          }
        }
        const rewrite = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`, GIT_CONFIG_VALUE_0: SSH_URL }
        return real(args, { ...opts, env: { ...opts.env, ...rewrite } })
      }
    }
  }

  it('T-PQ-C4-01: prefer: every network git call of a sync over ssh carries the KexAlgorithms=^ command', async () => {
    const calls: Call[] = []
    const a = await device('A', { enabled: false, gitRunner: recordingRunner(calls), probeSsh: async () => hybridSsh })
    writePage(a.store, 'over ssh')
    await a.service.configure({ provider: 'git', git: { remoteUrl: SSH_URL, branch: 'main', auth: 'system' } })
    expect((await a.service.status()).status).toBe('idle-synced')
    const network = calls.filter((c) => NETWORK.has(c.args[0]!))
    expect(network.map((c) => c.args[0])).toEqual(expect.arrayContaining(['fetch', 'push']))
    expect(network.every((c) => c.ssh === PREFER)).toBe(true)
    expect(refs()).toContain('refs/heads/main')
  })

  it('T-PQ-C4-02: require: a server without hybrids fails the sync with PqTransportUnavailable, a notice, and nothing pushed', async () => {
    const calls: Call[] = []
    const a = await device('A', { enabled: false, gitRunner: recordingRunner(calls, true), probeSsh: async () => hybridSsh })
    writeSettings(a.store, { syncRequirePq: true })
    writePage(a.store, 'must not leave')
    await a.service.configure({ provider: 'git', git: { remoteUrl: SSH_URL, branch: 'main', auth: 'system' } })
    expect(await a.service.status()).toMatchObject({ status: 'error', message: 'This server does not offer post-quantum key exchange' })
    expect(a.notices).toContain('This server does not offer post-quantum key exchange')
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false)
    expect(calls.filter((c) => NETWORK.has(c.args[0]!)).every((c) => c.ssh === REQUIRE)).toBe(true)
    expect(refs()).toBe('')
  })

  it('T-PQ-C4-02: require: an ssh with no hybrid refuses before any git call', async () => {
    const calls: Call[] = []
    const a = await device('A', { enabled: false, gitRunner: recordingRunner(calls), probeSsh: async () => ({ hybrid: [], ssh: 'OpenSSH_8.9', prepend: false }) })
    writeSettings(a.store, { syncRequirePq: true })
    writePage(a.store, 'must not leave')
    await a.service.configure({ provider: 'git', git: { remoteUrl: SSH_URL, branch: 'main', auth: 'system' } })
    expect((await a.service.status()).status).toBe('error')
    expect(calls.filter((c) => NETWORK.has(c.args[0]!))).toEqual([])
    expect(refs()).toBe('')
  })

  it('T-PQ-C4-03: require with an https git remote is refused before any git call', async () => {
    const calls: Call[] = []
    const a = await device('A', { enabled: false, gitRunner: recordingRunner(calls), probeSsh: async () => hybridSsh })
    writeSettings(a.store, { syncRequirePq: true })
    await a.service.configure({ provider: 'git', git: { remoteUrl: HTTPS_URL, branch: 'main', auth: 'system' } })
    expect(await a.service.status()).toMatchObject({ status: 'error', message: 'Use an SSH remote for post-quantum key exchange' })
    expect(a.notices).toContain('Use an SSH remote for post-quantum key exchange')
    expect(calls).toEqual([])
    expect(await a.service.testGit({ remoteUrl: HTTPS_URL, branch: 'main', auth: 'system' })).toEqual({ ok: false, message: 'Use an SSH remote for post-quantum key exchange' })
    expect(calls).toEqual([])
  })

  it('T-PQ-C4-03: require with OneDrive is refused before any request', async () => {
    let requests = 0
    const counter = createServer((_req, res) => {
      requests++
      res.statusCode = 503
      res.end()
    })
    await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve))
    try {
      const a = await device('A', { enabled: false, graphUrl: `http://127.0.0.1:${(counter.address() as AddressInfo).port}/v1.0` })
      writeSettings(a.store, { syncRequirePq: true })
      writePage(a.store, 'must not leave')
      await a.service.setEnabled(true)
      expect(await a.service.status()).toMatchObject({ status: 'error', message: 'Microsoft OneDrive does not offer post-quantum key exchange yet' })
      expect(await a.service.ensureBlob('0'.repeat(64))).toBe(false)
      expect(requests).toBe(0)
    } finally {
      await new Promise<void>((resolve) => counter.close(() => resolve()))
    }
  })

  it('a file:// remote is untouched by the policy, with require on', async () => {
    const calls: Call[] = []
    let probes = 0
    const a = await device('A', {
      enabled: false,
      gitRunner: recordingRunner(calls),
      probeSsh: async () => {
        probes++
        return hybridSsh
      },
    })
    writeSettings(a.store, { syncRequirePq: true })
    writePage(a.store, 'local')
    await a.service.configure({ provider: 'git', git: { remoteUrl: `file://${bare}`, branch: 'main', auth: 'system' } })
    expect((await a.service.status()).status).toBe('idle-synced')
    expect(calls.every((c) => c.ssh === undefined)).toBe(true)
    expect(probes).toBe(0)
  })
})
