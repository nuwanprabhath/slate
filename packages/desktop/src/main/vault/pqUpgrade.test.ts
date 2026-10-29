// PQ-B3 (roadmap §3.4–§3.5): the v2 → v3 header upgrade after unlock. INV-PQ-2 (no note ciphertext changes),
// INV-PQ-3 (every secret keeps working), INV-PQ-4 (no v2 copy is accepted afterwards), INV-PQ-5 (no v3 while a
// device lacks `pq`).
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeGitRunner } from '@slate/sync'
import { secretBytes } from '../../shared/secret'
import { openDatabase } from '../db/openDatabase'
import { securityEvent } from '../log/securityEvents'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { destroyProof, parseHeader, proveSecret, type VaultHeader } from './header'
import type { KeyRing } from './keyring'
import { finishMigrationAtUnlock, MIGRATION_FILE } from './migration'
import { HeaderRefused, PROFILE_FLOOR_FILE } from './profileFloor'
import { nextCompletedSync, PQ_CANDIDATE_FILE, pqVaultReadiness, runPqUpgrade, startPqUpgrade, type PqUpgradeDeps } from './pqUpgrade'
import { blobName, memoryRemote, snapshot, tempRoot, testDevice, TEST_PASSWORD, weak, type TestDevice } from '../../../test/pqDevice'
import { enableQuickUnlock, openQuickUnlock, type QuickUnlockPlatform } from './quickUnlock'
import { GitVaultRemote, type VaultRemote } from './remoteVault'
import { readSeen, SEEN_FILE, writeSeen } from './seen'
import { storeWithLk } from './testVault'
import { unlockVault, VAULT_FILE } from './unlock'
import { checkRemoteVault } from './vaultCheck'

vi.setConfig({ testTimeout: 60_000 })
const root = tempRoot('upgrade')
const rings: KeyRing[] = []
afterEach(() => {
  for (const r of rings.splice(0)) if (r.isOpen) r.close()
  vi.restoreAllMocks()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const platform: QuickUnlockPlatform = {
  platform: 'linux',
  secrets: { available: async () => true, seal: async (s: string) => Buffer.from(s), open: async (b: Uint8Array) => ({ plain: Buffer.from(b).toString(), rewrite: false }) } as unknown as QuickUnlockPlatform['secrets'],
  systemPreferences: {},
}

async function device(notes = 3): Promise<TestDevice> {
  const d = await testDevice(root, notes)
  rings.push(d.ring)
  return d
}

function deps(d: TestDevice, extra: Partial<PqUpgradeDeps> = {}): PqUpgradeDeps {
  return { dataDir: d.dir, kdfOpts: weak, keyRing: d.ring, remote: () => null, selfTest: async () => true, ...extra }
}

const local = async (dir: string): Promise<VaultHeader> => parseHeader(await readJsonCapped(join(dir, VAULT_FILE)), weak)

async function notesUnder(dir: string, secret: Parameters<typeof unlockVault>[1]): Promise<number> {
  const u = await unlockVault(dir, secret, weak)
  rings.push(u.keyRing)
  const store = storeWithLk(u.keyRing, u.dbFile)
  try {
    return store.list('').length
  } finally {
    store.close()
    u.keyRing.close()
  }
}

/** A device already syncing with `remote`: the remote holds its header, and it saw that header there. */
async function onRemote(d: TestDevice, remote: VaultRemote): Promise<void> {
  const snap = await remote.read()
  if (snap.header === null) expect(await remote.writeHeader(d.header, null)).toBe(true)
  await writeSeen(d.dir, d.header)
}

function bareRepo(): { bare: string; remote: (name: string) => GitVaultRemote } {
  const bare = join(root, `bare-${Date.now()}-${rings.length}.git`)
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
  const work = join(root, `git-${Date.now()}-${rings.length}`)
  return { bare, remote: (name) => new GitVaultRemote({ run: nodeGitRunner(), dir: join(work, name), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}) }) }
}

describe('PQ-B3: the v2 → v3 header upgrade', () => {
  it('T-PQ-B3-01: after the upgrade the old password, the recovery key and quick unlock each unlock, and the note count is unchanged', async () => {
    const d = await device(4)
    const proof = await proveSecret(d.header, { password: secretBytes(TEST_PASSWORD) }, weak)
    await enableQuickUnlock(d.dir, proof, platform, d.ring.schedule)
    destroyProof(proof)
    const out = await runPqUpgrade(deps(d))
    expect(out.state).toBe('done')
    d.ring.close()
    const h = await local(d.dir)
    expect(h).toMatchObject({ version: 3, revision: d.header.revision + 1, pq: { kem: 'hybrid-only', minCapability: 1 } })
    expect(await notesUnder(d.dir, { password: secretBytes(TEST_PASSWORD) })).toBe(4)
    expect(await notesUnder(d.dir, { recoveryKey: secretBytes(d.recoveryKey) })).toBe(4)
    expect(await notesUnder(d.dir, { mk: await openQuickUnlock(d.dir, platform) })).toBe(4)
    expect(existsSync(join(d.dir, MIGRATION_FILE))).toBe(false)
    expect(existsSync(join(d.dir, PQ_CANDIDATE_FILE))).toBe(false)
    expect(pqVaultReadiness()).toEqual({ kind: 'header', version: 3, upgrade: 'done' })
  })

  it('T-PQ-B3-02: zero loss: every data-folder file but the header files, every blob_data row, the SQLCipher bytes and every remote path but e2ee/vault.json are byte-identical', async () => {
    const d = await device(3)
    const git = bareRepo()
    const remote = git.remote('a')
    await onRemote(d, remote)
    // Other encrypted files on the remote, as a sync leaves them.
    const clone = join(root, `clone-${Date.now()}`)
    execFileSync('git', ['clone', '-q', git.bare, clone])
    mkdirSync(join(clone, 'e2ee', 'd'), { recursive: true })
    writeFileSync(join(clone, 'e2ee', 'd', 'sealed-note'), Buffer.from([1, 2, 3, 250]))
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    execFileSync('git', ['add', '-A'], { cwd: clone, env })
    execFileSync('git', ['commit', '-q', '-m', 'sync'], { cwd: clone, env })
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: clone, env })
    const remoteFiles = () => {
      const files = execFileSync('git', ['ls-tree', '-r', 'main'], { cwd: git.bare, encoding: 'utf8' }).trim().split('\n')
      return files.filter((l) => !l.endsWith('\te2ee/vault.json'))
    }
    const dbFile = join(d.dir, `slate-${d.header.vaultId.slice(0, 8)}.db`)
    const rows = () => {
      const db = openDatabase(dbFile, d.ring.get('lk'), { readonly: true })
      try {
        return db.prepare('SELECT name, data FROM blob_data ORDER BY name').all() as Array<{ name: string; data: Buffer }>
      } finally {
        db.close()
      }
    }
    // The header files change by design; vault.seen.json is the copy of the remote header this device last saw.
    const SKIP = [VAULT_FILE, PROFILE_FLOOR_FILE, MIGRATION_FILE, SEEN_FILE]
    const rowsBefore = rows()
    const before = snapshot(d.dir, SKIP)
    const remoteBefore = remoteFiles()
    expect(rowsBefore.map((r) => r.name)).toEqual([blobName()])
    const out = await runPqUpgrade(deps(d, { remote: () => remote, devices: async () => [{ name: 'this one', epochs: 1, pq: 1 }] }))
    expect(out.state).toBe('done')
    expect(snapshot(d.dir, SKIP)).toEqual(before)
    expect(readFileSync(dbFile).equals(Buffer.from(before[`slate-${d.header.vaultId.slice(0, 8)}.db`]!, 'base64'))).toBe(true)
    expect(rows()).toEqual(rowsBefore)
    expect(remoteFiles()).toEqual(remoteBefore)
    expect(parseHeader((await remote.read()).header, weak)).toMatchObject({ version: 3, revision: d.header.revision + 1 })
    expect((await readSeen(d.dir, weak))?.version).toBe(3)
  })

  it('T-PQ-B3-04: one remote device record without pq: nothing is written, the state is waiting-devices and only the count is logged', async () => {
    const d = await device(1)
    const mem = memoryRemote()
    await onRemote(d, mem.remote)
    const waiting = vi.spyOn(securityEvent, 'headerUpgradeWaiting')
    const before = snapshot(d.dir)
    const writes = mem.writes()
    const out = await runPqUpgrade(deps(d, { remote: () => mem.remote, devices: async () => [{ name: 'This Mac', epochs: 1, pq: 1 }, { name: 'Old laptop', epochs: 1 }] }))
    expect(out).toEqual({ state: 'waiting-devices', waiting: { reason: 'devices', devices: ['Old laptop'] } })
    expect(snapshot(d.dir)).toEqual(before)
    expect(mem.writes()).toBe(writes)
    expect(waiting).toHaveBeenCalledWith({ devices: 1 })
    expect(pqVaultReadiness()).toEqual({ kind: 'header', version: 2, upgrade: 'waiting-devices', waiting: { reason: 'devices', devices: ['Old laptop'] } })
    // A record list that cannot be read blocks too, and the readiness says so instead of naming a device.
    const unread = await runPqUpgrade(deps(d, { remote: () => mem.remote, devices: async () => Promise.reject(new Error('offline')) }))
    expect(unread.state).toBe('waiting-devices')
    expect(snapshot(d.dir)).toEqual(before)
    expect(pqVaultReadiness()).toEqual({ kind: 'header', version: 2, upgrade: 'waiting-devices', waiting: { reason: 'devices-unreadable' } })
    // Sync off on a vault that has synced before: its other devices cannot be asked, so it waits too.
    const off = await runPqUpgrade(deps(d, { remote: () => null }))
    expect(off.state).toBe('waiting-devices')
    expect(snapshot(d.dir)).toEqual(before)
    expect(pqVaultReadiness()).toEqual({ kind: 'header', version: 2, upgrade: 'waiting-devices', waiting: { reason: 'sync-off' } })
    expect(waiting.mock.calls.every(([f]) => Object.keys(f).join() === 'devices' && typeof f.devices === 'number')).toBe(true)
  })

  it("this device's own record from 0.3.0 (no pq until this build's first sync) does not hold the upgrade back", async () => {
    const d = await device(1)
    const mem = memoryRemote()
    await onRemote(d, mem.remote)
    const out = await runPqUpgrade(deps(d, { remote: () => mem.remote, devices: async () => [{ name: 'This Mac', epochs: 1, own: true }, { name: 'nuwan-ubuntu', epochs: 1, pq: 1 }] }))
    expect(out).toEqual({ state: 'done' })
    expect(pqVaultReadiness()).toEqual({ kind: 'header', version: 3, upgrade: 'done' })
  })

  it('T-PQ-B3-05: after the upgrade the old v2 header, locally or as the remote copy, is refused as a downgrade', async () => {
    const d = await device(1)
    const mem = memoryRemote()
    await onRemote(d, mem.remote)
    expect((await runPqUpgrade(deps(d, { remote: () => mem.remote, devices: async () => [] }))).state).toBe('done')
    expect(JSON.parse(readFileSync(join(d.dir, PROFILE_FLOOR_FILE), 'utf8'))).toMatchObject({ minHeaderVersion: 3 })
    const refused = vi.spyOn(securityEvent, 'headerRefused')
    // The remote copy: sync stops, and nothing is written over it.
    mem.set(d.header)
    const writes = mem.writes()
    await expect(checkRemoteVault({ remote: mem.remote, dataDir: d.dir, keyRing: d.ring, opts: weak })).rejects.toThrow(/older or weaker/)
    expect(mem.writes()).toBe(writes)
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ reason: 'downgrade', headerVersion: 2 }), 'sync')
    d.ring.close()
    // The local copy, with its valid MAC.
    await writeJsonAtomic(join(d.dir, VAULT_FILE), d.header)
    await expect(unlockVault(d.dir, { password: secretBytes(TEST_PASSWORD) }, weak)).rejects.toThrow(HeaderRefused)
  })

  it('T-PQ-B3-06: two devices over one in-memory remote upgrading together end on one v3 header at base + 1; the loser writes nothing of its own', async () => {
    const a = await device(2)
    // B is a second device of A's vault: a copy of A's folder, opened on its own.
    const b = { dir: `${a.dir}-b` }
    execFileSync('cp', ['-R', a.dir, b.dir])
    const bRing = (await unlockVault(b.dir, { password: secretBytes(TEST_PASSWORD) }, weak)).keyRing
    rings.push(bRing)
    const mem = memoryRemote()
    await onRemote(a, mem.remote)
    await writeSeen(b.dir, a.header)
    const writes = mem.writes()
    const both = await Promise.all([
      runPqUpgrade(deps(a, { remote: () => mem.remote, devices: async () => [] })),
      runPqUpgrade({ ...deps(a, { remote: () => mem.remote, devices: async () => [] }), dataDir: b.dir, keyRing: bRing }),
    ])
    expect(both.map((o) => o.state)).toEqual(['done', 'done'])
    expect(mem.writes() - writes).toBe(1)
    const theirs = parseHeader((await mem.remote.read()).header, weak)
    expect(theirs).toMatchObject({ version: 3, revision: a.header.revision + 1 })
    expect(await local(a.dir)).toEqual(theirs)
    expect(await local(b.dir)).toEqual(theirs)
  })

  it('T-PQ-B3-06: the same two devices over a local bare git repository', async () => {
    const a = await device(1)
    const bDir = `${a.dir}-b`
    execFileSync('cp', ['-R', a.dir, bDir])
    const bRing = (await unlockVault(bDir, { password: secretBytes(TEST_PASSWORD) }, weak)).keyRing
    rings.push(bRing)
    const git = bareRepo()
    const ra = git.remote('a')
    const rb = git.remote('b')
    await onRemote(a, ra)
    await writeSeen(bDir, a.header)
    const both = await Promise.all([
      runPqUpgrade(deps(a, { remote: () => ra, devices: async () => [] })),
      runPqUpgrade({ ...deps(a, { remote: () => rb, devices: async () => [] }), dataDir: bDir, keyRing: bRing }),
    ])
    expect(both.map((o) => o.state)).toEqual(['done', 'done'])
    const log = execFileSync('git', ['log', '--format=%s', 'main'], { cwd: git.bare, encoding: 'utf8' }).trim().split('\n')
    // The claim, then exactly one header write.
    expect(log).toEqual(['slate: vault', 'slate: encrypted'])
    const theirs = parseHeader((await ra.read()).header, weak)
    expect(theirs).toMatchObject({ version: 3, revision: a.header.revision + 1 })
    expect(await local(bDir)).toEqual(theirs)
  })

  it('a remote that moved (a password change elsewhere) is built on: the v3 header keeps the newer wraps', async () => {
    const a = await device(1)
    const mem = memoryRemote()
    await onRemote(a, mem.remote)
    const { changePassword } = await import('./header')
    const proof = await proveSecret(a.header, { password: secretBytes(TEST_PASSWORD) }, weak)
    const moved = await changePassword(a.header, a.ring.get('mk'), proof, secretBytes('a changed password elsewhere'), weak)
    destroyProof(proof)
    mem.set(moved)
    expect((await runPqUpgrade(deps(a, { remote: () => mem.remote, devices: async () => [] }))).state).toBe('done')
    const theirs = parseHeader((await mem.remote.read()).header, weak)
    expect(theirs).toMatchObject({ version: 3, revision: moved.revision + 1 })
    expect(theirs.wraps.password).toEqual(moved.wraps.password)
    expect(await local(a.dir)).toEqual(theirs)
  })

  it('T-PQ-B3-08: a version-4 remote header is refused (schema): the sync check stops and the upgrade writes nothing', async () => {
    const d = await device(1)
    const mem = memoryRemote()
    await onRemote(d, mem.remote)
    mem.set({ ...d.header, version: 4 })
    const refused = vi.spyOn(securityEvent, 'headerRefused')
    const before = snapshot(d.dir)
    const writes = mem.writes()
    await expect(checkRemoteVault({ remote: mem.remote, dataDir: d.dir, keyRing: d.ring, opts: weak })).rejects.toThrow()
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ reason: 'schema', headerVersion: 4 }), 'sync')
    const out = await runPqUpgrade(deps(d, { remote: () => mem.remote, devices: async () => [] }))
    expect(out.state).toBe('stopped')
    expect(mem.writes()).toBe(writes)
    expect(snapshot(d.dir)).toEqual(before)
  })

  it('T-PQ-B3-09: the upgrade starts only after a passing pre-change self-test; a failing one ends in selftest-failed with nothing written', async () => {
    const d = await device(1)
    const before = snapshot(d.dir)
    let ran = 0
    const out = await runPqUpgrade(deps(d, { selfTest: async () => (ran++, false) }))
    expect(out.state).toBe('selftest-failed')
    expect(ran).toBe(1)
    expect(snapshot(d.dir)).toEqual(before)
    expect((await runPqUpgrade(deps(d, { selfTest: async () => (ran++, true) }))).state).toBe('done')
    expect(ran).toBe(2)
  })

  it('a pq-header record survives the unlock clean-up of an encryption record (it is not §7.4 left-overs)', async () => {
    const d = await device(1)
    const record = { kind: 'pq-header', id: '0011223344556677', step: 'committed', vaultId: d.header.vaultId, fromRevision: 1, toRevision: 2 }
    await writeJsonAtomic(join(d.dir, MIGRATION_FILE), record)
    expect(await finishMigrationAtUnlock(d.dir, { warn: () => {} })).toBe(true)
    expect(JSON.parse(readFileSync(join(d.dir, MIGRATION_FILE), 'utf8'))).toEqual(record)
  })

  it('a v3 vault is done at once, and adopting a pending v3 header of the same keys writes it locally without the remote', async () => {
    const a = await device(1)
    expect((await runPqUpgrade(deps(a))).state).toBe('done')
    const v3 = await local(a.dir)
    expect((await runPqUpgrade(deps(a))).state).toBe('done')
    expect(await local(a.dir)).toEqual(v3)
    // B: still on v2 with A's v3 as the pending header (the sync check stored it).
    const b = await device(1)
    const mem = memoryRemote()
    await onRemote(b, mem.remote)
    const { buildHeaderV3From } = await import('./header')
    const pending = buildHeaderV3From(b.header as Parameters<typeof buildHeaderV3From>[0], b.ring.get('mk'))
    await writeJsonAtomic(join(b.dir, 'vault.pending.json'), pending)
    const adopted = vi.spyOn(securityEvent, 'headerAdopted')
    const writes = mem.writes()
    expect((await runPqUpgrade(deps(b, { remote: () => mem.remote, devices: async () => [] }))).state).toBe('done')
    expect(mem.writes()).toBe(writes)
    expect(await local(b.dir)).toEqual(pending)
    expect(existsSync(join(b.dir, 'vault.pending.json'))).toBe(false)
    expect(adopted).toHaveBeenCalledWith({ fromRevision: b.header.revision, toRevision: pending.revision })
  })

  it('§3.5 Waiting → Gate: after the next completed sync the gate is asked again, and the upgrade then runs', async () => {
    const d = await device(1)
    const mem = memoryRemote()
    await onRemote(d, mem.remote)
    // This device's own record from before the update lacks pq until its first sync on this build rewrites it.
    let synced = 0
    const records = () => [{ name: 'This Mac', epochs: 1, ...(synced > 0 ? { pq: 1 } : {}) }]
    await startPqUpgrade({
      ...deps(d, { remote: () => mem.remote, devices: async () => records() }),
      nextSync: async () => {
        synced++
        return true
      },
    })
    expect(synced).toBe(1)
    expect((await local(d.dir)).version).toBe(3)
    let at = 1
    const active = { on: true }
    const waited = nextCompletedSync(async () => at, () => active.on, 5)
    at = 2
    expect(await waited).toBe(true)
    active.on = false
    expect(await nextCompletedSync(async () => at, () => active.on, 5)).toBe(false)
  })
})
