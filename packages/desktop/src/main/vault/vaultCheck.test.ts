import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleOf } from './header'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { nodeGitRunner } from '@slate/sync'
import { startFakeDrive } from '../../../../sync/test/fakeDrive'
import type { SyncState } from '../../shared/api'
import { FileBlobStore } from '../blobs'
import { createAuthService } from '../onenote/auth'
import { writeSettings } from '../settings'
import { DocStore } from '../store'
import { SyncService } from '../sync/syncService'
import { writeJsonAtomic } from './atomic'
import { proveSecret, createVault, newRecoveryKey, parseHeader, type VaultHeader } from './header'
import type { KeyHandle } from '@slate/native'
import { importKey } from '../../../test/vaultKeys'
import { KeyRing } from './keyring'
import { GitVaultRemote } from './remoteVault'
import { PENDING_FILE, VAULT_FILE } from './unlock'
import { checkRemoteVault, VaultSyncProblem } from './vaultCheck'
import { secretBytes } from '../../shared/secret'

// Each test spawns tens of git processes; 5 s is too tight on a loaded machine.
vi.setConfig({ testTimeout: 30_000 })
const weak = { allowWeakForTests: true }
let dir: string
let bare: string
let dataDir: string

const remote = (name = 'vr') => new GitVaultRemote({ run: nodeGitRunner(), dir: join(dir, name), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}) })
const makeVault = () => createVault({ password: secretBytes('correct horse battery'), kdf: { memoryKiB: 64, passes: 1 } }, weak)
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

async function encryptedDevice(header: VaultHeader, mk: KeyHandle): Promise<KeyRing> {
  await writeJsonAtomic(join(dataDir, VAULT_FILE), header)
  return new KeyRing(mk, importKey(Buffer.alloc(32, 1), 'db'), scheduleOf(header))
}

const problem = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof VaultSyncProblem ? e.problem : `other: ${String(e)}`))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-vault-check-'))
  bare = join(dir, 'remote.git')
  dataDir = join(dir, 'data')
  mkdirSync(dataDir)
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('checkRemoteVault', () => {
  it('a plaintext device stops at a remote vault: join needed', async () => {
    const { header } = await makeVault()
    await remote('a').claim(header, null)
    expect(await problem(checkRemoteVault({ remote: remote(), dataDir, keyRing: null, opts: weak }))).toBe('join-needed')
  })

  it('a plaintext device with a plaintext remote carries on', async () => {
    expect(await problem(checkRemoteVault({ remote: remote(), dataDir, keyRing: null, opts: weak }))).toBeNull()
  })

  it('a higher revision of our vault is stored as pending, and sync carries on', async () => {
    const { header, mk } = await makeVault()
    const keyRing = await encryptedDevice(header, mk)
    await remote('a').claim(newRecoveryKey(header, mk, await proveSecret(header, { password: secretBytes('correct horse battery') }, weak)).header, null)
    expect(await problem(checkRemoteVault({ remote: remote(), dataDir, keyRing, opts: weak }))).toBeNull()
    expect(parseHeader(JSON.parse(readFileSync(join(dataDir, PENDING_FILE), 'utf8')), weak).revision).toBe(2)
  })

  it('a higher revision that does not verify under our key is not stored', async () => {
    const { header, mk } = await makeVault()
    const keyRing = await encryptedDevice(header, mk)
    const forged = { ...newRecoveryKey(header, mk, await proveSecret(header, { password: secretBytes('correct horse battery') }, weak)).header, check: Buffer.alloc(32).toString('base64') }
    await remote('a').claim(forged, null)
    await checkRemoteVault({ remote: remote(), dataDir, keyRing, opts: weak }).catch(() => {})
    expect(existsSync(join(dataDir, PENDING_FILE))).toBe(false)
  })

  it('a different vault is refused', async () => {
    const ours = await makeVault()
    const theirs = await makeVault()
    const keyRing = await encryptedDevice(ours.header, ours.mk)
    await remote('a').claim(theirs.header, null)
    expect(await problem(checkRemoteVault({ remote: remote(), dataDir, keyRing, opts: weak }))).toBe('other-vault')
  })

  it('an encrypted device refuses a plaintext remote', async () => {
    const work = join(dir, 'work')
    git(dir, 'clone', '-q', bare, work)
    git(work, 'checkout', '-q', '-b', 'main')
    mkdirSync(join(work, 'docs'))
    writeFileSync(join(work, 'docs/x'), 'PLAIN')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'x')
    git(work, 'push', '-q', 'origin', 'main')
    const { header, mk } = await makeVault()
    const keyRing = await encryptedDevice(header, mk)
    expect(await problem(checkRemoteVault({ remote: remote(), dataDir, keyRing, opts: weak }))).toBe('not-encrypted')
  })

  it('an encrypted device writes its vault to an empty remote and carries on', async () => {
    const { header, mk } = await makeVault()
    const keyRing = await encryptedDevice(header, mk)
    expect(await problem(checkRemoteVault({ remote: remote(), dataDir, keyRing, opts: weak }))).toBeNull()
    expect(parseHeader((await remote('b').read()).header, weak).vaultId).toBe(header.vaultId)
  })
})

describe('SyncService with a vault check on OneDrive', () => {
  it('syncs while the drive has no vault, and stops at join-needed once it has one', async () => {
    const drive = await startFakeDrive()
    const dbFile = join(dataDir, 'slate.db')
    const store = new DocStore(dbFile)
    const doc = new LoroDoc()
    doc.getText('t').insert(0, 'x')
    store.append(`page:${randomUUID()}`, doc.export({ mode: 'update' }))
    const auth = createAuthService({ clientId: null, cacheFile: join(dir, 'o.bin'), openBrowser: async () => {}, fake: true })
    const states: SyncState[] = []
    const service = new SyncService({
      dbFile,
      blobs: new FileBlobStore(join(dataDir, 'blobs')),
      auth,
      graphUrl: drive.url,
      gitDir: join(dataDir, 'git-sync'),
      secrets: { available: async () => true, seal: async (s) => Buffer.from(s), open: async (b) => ({ plain: b.toString(), rewrite: false }) },
      intervalMs: 0,
      emitStatus: (s) => states.push(s),
      emitNotice: () => {},
      checkVault: (r) => checkRemoteVault({ remote: r, dataDir, keyRing: null, opts: weak }),
    })
    try {
      await service.setEnabled(true)
      expect(states.at(-1)?.message ?? states.at(-1)?.status).toBe('idle-synced')
      drive.offline(true)
      await service.now()
      expect(states.at(-1)?.status).toBe('offline')
      drive.offline(false)
      const { header } = await makeVault()
      drive.files.set('e2ee/vault.json', new TextEncoder().encode(JSON.stringify(header)))
      await service.now()
      expect(states.at(-1)?.vaultProblem).toBe('join-needed')
    } finally {
      service.close()
      store.close()
      await drive.close()
    }
  })
})

describe('SyncService with a vault check', () => {
  it('a plaintext device uploads nothing to an encrypted remote and reports join-needed', async () => {
    const { header } = await makeVault()
    await remote('a').claim(header, null)
    const before = git(bare, 'rev-parse', 'main')
    const dbFile = join(dataDir, 'slate.db')
    const store = new DocStore(dbFile)
    writeSettings(store, { syncProvider: 'git', git: { remoteUrl: `file://${bare}`, branch: 'main', auth: 'system' } })
    store.append(`page:${randomUUID()}`, new Uint8Array([1]))
    const states: SyncState[] = []
    const service = new SyncService({
      dbFile,
      blobs: new FileBlobStore(join(dataDir, 'blobs')),
      auth: createAuthService({ clientId: null, cacheFile: join(dir, 'a.bin'), openBrowser: async () => {}, fake: true }),
      graphUrl: 'http://127.0.0.1:9',
      gitDir: join(dataDir, 'git-sync'),
      secrets: { available: async () => true, seal: async (s) => Buffer.from(s), open: async (b) => ({ plain: b.toString(), rewrite: false }) },
      intervalMs: 0,
      emitStatus: (s) => states.push(s),
      emitNotice: () => {},
      checkVault: (r) => checkRemoteVault({ remote: r, dataDir, keyRing: null, opts: weak }),
    })
    try {
      await service.pause()
      await service.now()
      expect(states).toEqual([])
      service.resume()
      const report = await service.now()
      expect(report.status).toBe('error')
      expect(states.at(-1)?.vaultProblem).toBe('join-needed')
      expect(git(bare, 'rev-parse', 'main')).toBe(before)
    } finally {
      service.close()
      store.close()
    }
  })
})
