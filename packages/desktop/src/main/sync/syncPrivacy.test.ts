import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PageDoc } from '@slate/core'
import { startFakeDrive, type FakeDrive } from '../../../../sync/test/fakeDrive'
import { addTextBox } from '../../../../sync/test/memoryLocal'
import type { GitSettings } from '../../shared/api'
import { DISCLOSURES, type ConsentFeature, type Consents } from '../../shared/privacy/consent'
import { FileBlobStore } from '../blobs'
import { createAuthService } from '../onenote/auth'
import { setPrivacySource } from '../privacy/gate'
import { readSettings, writeSettings } from '../settings'
import { DocStore } from '../store'
import { importKey } from '../../../test/vaultKeys'
import { SCHEDULE_V1 } from '../vault/suite'
import { KeyRing } from '../vault/keyring'
import { PlaintextSyncRefused, SyncService } from './syncService'

const PAGE = 'page:22222222-2222-4222-8222-222222222222'
const secrets = {
  available: async () => true,
  seal: async (s: string) => Buffer.from(`enc:${s}`),
  open: async (b: Buffer) => ({ plain: b.toString().slice(4), rewrite: false }),
}

let dir: string
let bare: string
let drive: FakeDrive
const open: Array<{ service: SyncService; store: DocStore }> = []

const grants = (...features: ConsentFeature[]): Consents =>
  Object.fromEntries(features.map((f) => [f, { grantedAt: 1, textVersion: DISCLOSURES[f].textVersion, source: 'user' }]))

interface Options {
  consents?: Consents
  strict?: boolean
  keyRing?: KeyRing
  deviceName?: string
}

async function device(name: string, opts: Options = {}) {
  const dbFile = join(dir, `${name}.db`)
  const store = new DocStore(dbFile)
  writeSettings(store, { gdprStrictMode: opts.strict ?? true, consents: opts.consents ?? {} })
  const auth = createAuthService({ clientId: null, cacheFile: join(dir, `${name}.bin`), openBrowser: async () => {}, fake: true })
  // The fake Microsoft sign-in is setup, not what these cases test: since B, signIn asks the global
  // gate for microsoftSignIn, so it runs with that consent and the gate goes back to failing closed.
  setPrivacySource(() => ({ ...readSettings(store), consents: grants('microsoftSignIn') }))
  try {
    await auth.signIn()
  } finally {
    setPrivacySource(() => null)
  }
  const notices: string[] = []
  const service = new SyncService({
    dbFile,
    blobs: new FileBlobStore(join(dir, `${name}-blobs`)),
    auth,
    graphUrl: drive.url,
    gitDir: join(dir, `${name}-git`),
    secrets,
    deviceName: opts.deviceName ?? 'Annas-MacBook-Pro',
    intervalMs: 0,
    emitStatus: () => {},
    emitNotice: (m) => notices.push(m),
    ...(opts.keyRing ? { keyRing: opts.keyRing } : {}),
  })
  open.push({ service, store })
  return { service, store, notices, gitDir: join(dir, `${name}-git`) }
}

const git = (): GitSettings => ({ remoteUrl: `file://${bare}`, branch: 'main', auth: 'system' })
const gitLog = (format: string) => execFileSync('git', ['--git-dir', bare, 'log', `--format=${format}`, 'main']).toString().trim().split('\n')
const remoteFile = (path: string) => execFileSync('git', ['--git-dir', bare, 'show', `main:${path}`]).toString()
const headOrNone = () => {
  try {
    return execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return null
  }
}
const ring = () => new KeyRing(importKey(Buffer.alloc(32, 7), 'master'), undefined, SCHEDULE_V1)

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'slate-sync-privacy-'))
  bare = join(dir, 'remote.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare])
  drive = await startFakeDrive()
})

afterEach(async () => {
  for (const d of open.splice(0)) {
    d.service.close()
    d.store.close()
  }
  await drive.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GDPR-03: consent before sync', { timeout: 60_000 }, () => {
  it('refuses a git provider without the gitSync consent, and saves nothing', async () => {
    const a = await device('A', { consents: grants('plaintextSync') })
    await expect(a.service.configure({ provider: 'git', git: git() })).rejects.toMatchObject({ name: 'ConsentRequired', feature: 'gitSync' })
    expect(readSettings(a.store)).toMatchObject({ syncProvider: null, git: null })
    expect(headOrNone()).toBeNull()
  })

  it('refuses OneDrive without the oneDriveSync consent, and saves nothing', async () => {
    const a = await device('A', { consents: grants('gitSync', 'plaintextSync') })
    await expect(a.service.setEnabled(true)).rejects.toMatchObject({ name: 'ConsentRequired', feature: 'oneDriveSync' })
    expect(readSettings(a.store).syncProvider).toBeNull()
    expect(drive.files.size).toBe(0)
  })

  it('refuses unencrypted sync under strict mode without the plaintextSync consent, before anything is saved', async () => {
    const a = await device('A', { consents: grants('gitSync') })
    const refusal = a.service.configure({ provider: 'git', git: git(), token: 'ghp_never' })
    await expect(refusal).rejects.toBeInstanceOf(PlaintextSyncRefused)
    await expect(refusal).rejects.toMatchObject({ name: 'PlaintextSyncRefused', message: 'Encrypt your notes first, or allow unencrypted sync' })
    expect(readSettings(a.store)).toMatchObject({ syncProvider: null, git: null })
    expect(await a.service.gitAuthInfo()).toMatchObject({ hasToken: false })
    expect(headOrNone()).toBeNull()
  })

  it('needs no plaintextSync consent once the notes are encrypted', async () => {
    const a = await device('A', { consents: grants('gitSync'), keyRing: ring() })
    await a.service.configure({ provider: 'git', git: git() })
    expect((await a.service.now()).status).toBe('idle-synced')
  })

  it('needs no plaintextSync consent with strict mode off', async () => {
    const a = await device('A', { strict: false })
    await a.service.configure({ provider: 'git', git: git() })
    expect((await a.service.now()).status).toBe('idle-synced')
  })

  it('pauses at the next run once a consent is withdrawn, as disabled with one notice, and pushes nothing', async () => {
    const a = await device('A', { consents: grants('gitSync', 'plaintextSync') })
    await a.service.configure({ provider: 'git', git: git() })
    const head = headOrNone()
    expect(head).not.toBeNull()
    writeSettings(a.store, { consents: grants('gitSync') })
    a.store.append(PAGE, (() => {
      const page = new PageDoc()
      addTextBox(page, 'written after the withdrawal')
      return page.doc.export({ mode: 'update' })
    })())
    const report = await a.service.now()
    expect(report).toMatchObject({ status: 'disabled', message: 'Sync paused: consent withdrawn' })
    await a.service.now()
    expect(a.notices.filter((n) => n === 'Sync paused: consent withdrawn')).toHaveLength(1)
    expect(headOrNone()).toBe(head)
    expect(readSettings(a.store).syncProvider).toBe('git')
  })

  it('sends no Graph request at all once oneDriveSync is withdrawn, whatever asks for it', async () => {
    const a = await device('A', { consents: grants('oneDriveSync', 'plaintextSync') })
    await a.service.setEnabled(true)
    const before = drive.files.size
    writeSettings(a.store, { consents: grants('plaintextSync') })
    await expect(a.service.deviceRecords()).rejects.toMatchObject({ name: 'ConsentRequired', feature: 'oneDriveSync' })
    expect(await a.service.ensureBlob('missing.png')).toBe(false)
    expect(drive.files.size).toBe(before)
  })

  it('resumes once the consent is given again', async () => {
    const a = await device('A', { consents: grants('gitSync', 'plaintextSync') })
    await a.service.configure({ provider: 'git', git: git() })
    writeSettings(a.store, { consents: {} })
    expect((await a.service.now()).status).toBe('disabled')
    writeSettings(a.store, { consents: grants('gitSync', 'plaintextSync') })
    expect((await a.service.now()).status).toBe('idle-synced')
  })
})

describe('GDPR-03: a pseudonymous identity on the remote', { timeout: 60_000 }, () => {
  it('under strict mode, without a vault, commits as Slate <slate@invalid> with "slate: sync" and names the device by its id', async () => {
    const a = await device('A', { consents: grants('gitSync', 'plaintextSync') })
    await a.service.configure({ provider: 'git', git: git() })
    expect((await a.service.now()).status).toBe('idle-synced')
    expect(gitLog('%an|%ae|%cn|%ce').every((l) => l === 'Slate|slate@invalid|Slate|slate@invalid')).toBe(true)
    expect(gitLog('%s').every((s) => s === 'slate: sync' || s === 'slate: initialise')).toBe(true)
    const record = JSON.parse(remoteFile(`devices/${a.service.deviceId}.json`)) as { name: string }
    expect(record.name).toBe(`Device ${a.service.deviceId.slice(0, 8)}`)
    const everything = execFileSync('git', ['--git-dir', bare, 'log', '-p', '--format=%an %ae %cn %ce %B', 'main']).toString()
    expect(everything).not.toContain('Annas-MacBook-Pro')
    expect(everything).not.toContain(hostname())
    expect(everything).not.toContain(`slate@${a.service.deviceId}.local`)
  })

  it('under strict mode with a vault keeps the neutral author, and the device record names no host', async () => {
    const a = await device('A', { consents: grants('gitSync'), keyRing: ring() })
    await a.service.configure({ provider: 'git', git: git() })
    expect((await a.service.now()).status).toBe('idle-synced')
    expect(gitLog('%an|%ae').every((l) => l === 'Slate|slate@invalid')).toBe(true)
    const names = (await a.service.deviceRecords()).map((r) => r.name)
    expect(names).toEqual([`Device ${a.service.deviceId.slice(0, 8)}`])
  })

  it('with strict mode off and no vault, keeps naming the device as before', async () => {
    const a = await device('A', { strict: false, deviceName: 'A' })
    await a.service.configure({ provider: 'git', git: git() })
    expect((await a.service.now()).status).toBe('idle-synced')
    expect(gitLog('%an')).toContain('Slate (A)')
    expect((await a.service.deviceRecords()).map((r) => r.name)).toEqual(['A'])
  })

  it('switches to the pseudonymous identity at the next run once strict mode is turned on', async () => {
    const a = await device('A', { strict: false, consents: grants('gitSync', 'plaintextSync') })
    await a.service.configure({ provider: 'git', git: git() })
    writeSettings(a.store, { gdprStrictMode: true })
    a.store.append(PAGE, (() => {
      const page = new PageDoc()
      addTextBox(page, 'after strict mode')
      return page.doc.export({ mode: 'update' })
    })())
    expect((await a.service.now()).status).toBe('idle-synced')
    expect(gitLog('%an|%s')[0]).toBe('Slate|slate: sync')
  })

  it('names the OneDrive device record by its id under strict mode', async () => {
    const a = await device('A', { consents: grants('oneDriveSync', 'plaintextSync') })
    await a.service.setEnabled(true)
    const record = JSON.parse(new TextDecoder().decode(drive.files.get(`devices/${a.service.deviceId}.json`))) as { name: string }
    expect(record.name).toBe(`Device ${a.service.deviceId.slice(0, 8)}`)
  })
})

/**
 * The rows half is `DocStore.forgetSync` (workstream D): a git connection's scoped prefix (`git:<url>#<branch>:`) or null
 * for OneDrive, plus a transport observation's remote or null. Here it is a fake on the service's own store.
 */
function fakeForgetSync(service: SyncService) {
  const calls: Array<[string | null, string | null]> = []
  const store = (service as unknown as { store: Record<string, unknown> }).store
  // D's contract: an empty prefix is refused (it would match every key).
  store.forgetSync = vi.fn((prefix: string | null, remote: string | null) => {
    if (prefix === '') throw new Error('forgetSync needs a prefix or null')
    calls.push([prefix, remote])
  })
  return calls
}

describe('GDPR-06: forget this connection', { timeout: 60_000 }, () => {
  it('stops sync, clears both tokens, removes this remote clone and its vault clone, forgets the rows and turns sync off', async () => {
    const a = await device('A', { consents: grants('gitSync', 'plaintextSync') })
    await a.service.configure({ provider: 'git', git: { ...git(), auth: 'token' }, token: 'ghp_secret' })
    expect((await a.service.now()).status).toBe('idle-synced')
    const tokenSecret = (a.service as unknown as { deviceSecret: { set(s: string): Promise<void> } }).deviceSecret
    await tokenSecret.set('gho_device')
    expect(await a.service.gitAuthInfo()).toMatchObject({ hasToken: true, hasDeviceToken: true })
    const clones = readdirSync(a.gitDir).filter((f) => !f.endsWith('.bin'))
    expect(clones.length).toBeGreaterThan(0)
    mkdirSync(join(a.gitDir, `${clones.find((c) => !c.endsWith('.vault'))!}.vault`), { recursive: true })
    const calls = fakeForgetSync(a.service)

    await a.service.forget()

    expect(await a.service.gitAuthInfo()).toMatchObject({ hasToken: false, hasDeviceToken: false })
    expect(readdirSync(a.gitDir).filter((f) => !f.endsWith('.bin'))).toEqual([])
    expect(existsSync(join(a.gitDir, 'token.bin'))).toBe(false)
    expect(existsSync(join(a.gitDir, 'github-device-token.bin'))).toBe(false)
    expect(calls).toEqual([[`git:file://${bare}#main:`, null]])
    expect(readSettings(a.store)).toMatchObject({ syncProvider: null, git: null })
    expect(await a.service.status()).toMatchObject({ enabled: false, status: 'disabled' })
    expect((await a.service.now()).status).toBe('disabled')
  })

  it('names the git transport observation to forget for a network remote', async () => {
    const a = await device('A', { consents: grants('gitSync', 'plaintextSync') })
    writeSettings(a.store, { syncProvider: 'git', git: { remoteUrl: 'git@github.com:me/notes.git', branch: 'main', auth: 'system' } })
    const calls = fakeForgetSync(a.service)
    await a.service.forget()
    expect(calls).toEqual([['git:git@github.com:me/notes.git#main:', 'git-ssh:github.com']])
  })

  it('forgets OneDrive by its unprefixed rows and each OneDrive host observation', async () => {
    const a = await device('A', { consents: grants('oneDriveSync', 'plaintextSync') })
    await a.service.setEnabled(true)
    const calls = fakeForgetSync(a.service)
    await a.service.forget()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(([prefix, remote]) => prefix === null && remote !== null && remote.startsWith('onedrive:'))).toBe(true)
    expect(readSettings(a.store).syncProvider).toBeNull()
    expect((await a.service.status()).enabled).toBe(false)
  })

  it('can be configured again after forgetting', async () => {
    const a = await device('A', { consents: grants('gitSync', 'plaintextSync') })
    await a.service.configure({ provider: 'git', git: git() })
    fakeForgetSync(a.service)
    await a.service.forget()
    await a.service.configure({ provider: 'git', git: git() })
    expect((await a.service.now()).status).toBe('idle-synced')
  })
})

describe('whilePaused', { timeout: 60_000 }, () => {
  it('runs no sync inside, and leaves a pause the caller did not make in place', async () => {
    const a = await device('A', { strict: false })
    await a.service.configure({ provider: 'git', git: git() })
    const head = headOrNone()
    await a.service.pause()
    const inside = await a.service.whilePaused(async () => {
      a.store.append(PAGE, (() => {
        const page = new PageDoc()
        addTextBox(page, 'during the pause')
        return page.doc.export({ mode: 'update' })
      })())
      return a.service.now()
    })
    expect(inside.status).toBe('idle-synced')
    expect(headOrNone()).toBe(head)
    // The migration's pause still holds after the inner one ended.
    await a.service.now()
    expect(headOrNone()).toBe(head)
    a.service.resume()
    expect((await a.service.now()).status).toBe('idle-synced')
    expect(headOrNone()).not.toBe(head)
  })

  it('nests: the service resumes only when the outermost one ends, and also after a throw', async () => {
    const a = await device('A', { strict: false })
    await a.service.configure({ provider: 'git', git: git() })
    const head = headOrNone()
    const edit = () => a.store.append(PAGE, (() => {
      const page = new PageDoc()
      addTextBox(page, 'nested')
      return page.doc.export({ mode: 'update' })
    })())
    await a.service.whilePaused(async () => {
      await expect(a.service.whilePaused(async () => { throw new Error('inner failed') })).rejects.toThrow('inner failed')
      edit()
      await a.service.now()
      expect(headOrNone()).toBe(head)
    })
    expect((await a.service.now()).status).toBe('idle-synced')
    expect(headOrNone()).not.toBe(head)
  })

  it('forget inside a migration pause leaves that pause in place', async () => {
    const a = await device('A', { consents: grants('gitSync', 'plaintextSync') })
    await a.service.configure({ provider: 'git', git: git() })
    fakeForgetSync(a.service)
    await a.service.pause()
    await a.service.forget()
    writeSettings(a.store, { syncProvider: 'git', git: git() })
    expect(await a.service.now()).toMatchObject({ status: 'disabled' })
    a.service.resume()
    expect((await a.service.now()).status).toBe('idle-synced')
  })
})
