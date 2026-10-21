import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PageDoc } from '@slate/core'
import { parseRemotePath } from '@slate/sync'
import { startFakeDrive, type FakeDrive } from '../../../../sync/test/fakeDrive'
import { addTextBox, boxText } from '../../../../sync/test/memoryLocal'
import type { GitAuthMode, SyncState } from '../../shared/api'
import { BlobStore } from '../blobs'
import { createAuthService } from '../onenote/auth'
import { writeSettings } from '../settings'
import { DocStore } from '../store'
import { SyncService } from './syncService'

const PAGE = 'page:11111111-1111-4111-8111-111111111111'

interface Device {
  store: DocStore
  blobs: BlobStore
  service: SyncService
  states: SyncState[]
  notices: string[]
}

const secrets = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4),
}

let dir: string
let drive: FakeDrive
const devices: Device[] = []

async function device(name: string, opts: { enabled?: boolean; signedIn?: boolean } = {}): Promise<Device> {
  const dbFile = join(dir, `${name}.db`)
  const store = new DocStore(dbFile)
  const blobs = new BlobStore(join(dir, `${name}-blobs`))
  const auth = createAuthService({ clientId: null, cacheFile: join(dir, `${name}.bin`), openBrowser: async () => {}, fake: true })
  if (opts.signedIn !== false) await auth.signIn()
  const states: SyncState[] = []
  const notices: string[] = []
  const service = new SyncService({
    dbFile,
    blobs,
    auth,
    graphUrl: drive.url,
    gitDir: join(dir, `${name}-git`),
    secrets,
    deviceName: name,
    intervalMs: 0,
    emitStatus: (s) => states.push(s),
    emitNotice: (m) => notices.push(m),
  })
  // setEnabled signs in when needed, so a signed-out device has the setting written directly.
  if (opts.enabled !== false && opts.signedIn === false) writeSettings(store, { syncProvider: 'onedrive' })
  else if (opts.enabled !== false) await service.setEnabled(true)
  const d = { store, blobs, service, states, notices }
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
})
