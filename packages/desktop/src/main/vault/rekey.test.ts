// C9 (audit §4.7, §7.3 C9): key rotation and the v1→v2 upgrade through the resumable migration runner. Criterion 2:
// a crash injected before every step recovers; criterion 3: a device that missed the rotation unlocks with its
// password through the pending header and follows; R-2: re-push, sweep and prune, driven by `migration.json`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { nodeGitRunner } from '@slate/sync'
import { writeSettings } from '../settings'
import { DocStore } from '../store'
import { liveHandles } from '../../../test/vaultKeys'
import { secretBytes } from '../../shared/secret'
import { openEnvelope } from './envelope'
import { buildHeaderV3From, changePassword, parseHeader, proveSecret, RotationRefused, unlockWithPassword, type VaultHeader, type VaultHeaderV2 } from './header'
import type { KeyRing } from './keyring'
import { Migration, MIGRATION_FILE, readRekeyRecord, REKEY_STEPS, type MigrationDeps, type RekeyStep, type SyncOutcome } from './migration'
import { destroyKey } from './native'
import { PROFILE_FLOOR_FILE } from './profileFloor'
import { PROFILES } from './profile'
import { GitVaultRemote, type VaultRemote } from './remoteVault'
import { SUITE } from './suite'
import { expectNotesSurviveCrash, notesUnder, storeWithLk } from './testVault'
import { CANDIDATE_FILE, LOCAL_KEYS_FILE, PENDING_FILE, SYNCED_FILE, unlockVault, VAULT_FILE } from './unlock'
import { SEEN_FILE } from './seen'
import { checkRemoteVault, VaultSyncProblem } from './vaultCheck'
import { PQ_CANDIDATE_FILE, runPqUpgrade } from './pqUpgrade'

vi.setConfig({ testTimeout: 30_000 })
const weak = { allowWeakForTests: true }
const PASSWORD = 'correct horse battery staple'
const PAGE = `page:${randomUUID()}`
let dir: string
let dataDir: string
let bare: string
let opened: Array<{ keyRing: KeyRing; dbFile: string; store: DocStore }>

function gitRemote(name = 'vr'): GitVaultRemote {
  return new GitVaultRemote({ run: nodeGitRunner(), dir: join(dir, name), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}) })
}

function deps(over: Partial<MigrationDeps> = {}, folder = dataDir): MigrationDeps {
  return {
    dataDir: folder,
    kdfOpts: weak,
    kdf: { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 },
    remote: () => null,
    closeServices: async () => {},
    reopenPlaintext: () => {},
    openServices: (keyRing, dbFile) => {
      const store = storeWithLk(keyRing, dbFile)
      opened.push({ keyRing, dbFile, store })
      return { store }
    },
    tempDir: join(dir, 'tmp'),
    ...over,
  }
}

function closeOpened(): void {
  for (const o of opened.splice(0)) {
    o.store.close()
    if (o.keyRing.isOpen) o.keyRing.close()
  }
}

/** A plaintext note encrypted by the wizard (§7.1); the open ring and its store, as the services hold them. */
async function encrypted(remote: VaultRemote | null = null, over: Partial<MigrationDeps> = {}): Promise<KeyRing> {
  mkdirSync(dataDir, { recursive: true })
  const store = new DocStore(join(dataDir, 'slate.db'))
  const doc = new LoroDoc()
  doc.getText('t').insert(0, 'SECRET-NOTE')
  store.append(PAGE, doc.export({ mode: 'update' }))
  writeSettings(store, { deviceId: randomUUID() })
  store.close()
  const m = new Migration(deps({ remote: () => remote, ...over }))
  const p = await m.prepare(secretBytes(PASSWORD))
  if (p.kind !== 'recovery') throw new Error('expected a new vault')
  expect(await m.confirmRecovery(secretBytes(p.recoveryKey))).toBe(true)
  await m.run()
  const first = opened.splice(0)[0]!
  first.store.close()
  return first.keyRing
}

async function rotate(m: Migration, ring: KeyRing, kind: 'rotate' | 'upgrade' = 'rotate'): Promise<KeyRing> {
  const { recoveryKey } = await m.prepareRekey(ring, kind, secretBytes(PASSWORD))
  expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
  const next = await m.runRekey(ring)
  opened.splice(0).forEach((o) => o.store.close())
  return next
}

/** The note as the unlocked vault stores it, opened the way unlock opens it. */
async function noteAfterUnlock(folder = dataDir, password = PASSWORD): Promise<{ text: string; epoch: number }> {
  const { keyRing, dbFile } = await unlockVault(folder, { password: secretBytes(password) }, weak)
  const store = storeWithLk(keyRing, dbFile)
  try {
    const doc = new LoroDoc()
    doc.importBatch(store.load(PAGE))
    return { text: doc.getText('t').toString(), epoch: keyRing.schedule.suite === SUITE.KBKDF_AES256GCM ? keyRing.schedule.keyEpoch : 0 }
  } finally {
    store.close()
    keyRing.close()
  }
}

/** A gate PQ-B4 keeps shut: sync off on a vault that has synced, so its devices cannot be asked (INV-PQ-5). */
const CLOSED_GATE: Partial<MigrationDeps> = { syncedBefore: async () => true }
/** Device records of builds that read header v3 (PQ-B2) and follow key changes (C9). */
const PQ_DEVICES = [{ name: 'Laptop', appVersion: '0.4.0', epochs: 1, pq: 1 }]
/** One device of 0.3.x: it follows key changes but would call header v3 damaged. */
const OLD_DEVICES = [{ name: 'Laptop', appVersion: '0.4.0', epochs: 1, pq: 1 }, { name: 'Desktop', appVersion: '0.3.0', epochs: 1 }]

/** `remote`, counting its header writes (a claim, or a compare-and-swap of `e2ee/vault.json`). */
function counted(remote: VaultRemote): { remote: VaultRemote; writes: () => number } {
  let writes = 0
  return {
    remote: {
      read: () => remote.read(),
      claim: (h, v) => (writes++, remote.claim(h, v)),
      writeHeader: (h, v) => (writes++, remote.writeHeader(h, v)),
    },
    writes: () => writes,
  }
}

const header = (folder = dataDir) => parseHeader(JSON.parse(readFileSync(join(folder, VAULT_FILE), 'utf8')), weak)
const remoteHeader = async (remote: VaultRemote) => parseHeader((await remote.read()).header, weak)
const databases = (folder = dataDir) => readdirSync(folder).filter((f) => /^slate-[0-9a-f]{8}\.db$/.test(f))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-rekey-'))
  dataDir = join(dir, 'data')
  bare = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
  opened = []
})

afterEach(() => {
  closeOpened()
  rmSync(dir, { recursive: true, force: true })
})

describe('C9 key rotation through the migration runner', () => {
  it('rotation round trip without sync: epoch 1, the same password, the notes under a fresh LK, nothing left over', async () => {
    // A header-v2 vault (the PQ gate was closed when it was made): a rotation keeps it v2.
    const ring = await encrypted(null, CLOSED_GATE)
    const oldDb = databases()[0]
    const next = await rotate(new Migration(deps()), ring)
    expect(ring.isOpen).toBe(false)
    expect(header()).toMatchObject({ version: 2, keyEpoch: 1, revision: 2 })
    expect((header() as VaultHeaderV2).history?.map((h) => h.epoch)).toEqual([0])
    expect(next.historyEpochs).toEqual([0])
    expect(JSON.parse(readFileSync(join(dataDir, LOCAL_KEYS_FILE), 'utf8'))).toMatchObject({ version: 2, keyEpoch: 1 })
    next.close()
    expect(databases()).not.toContain(oldDb)
    expect(databases()).toHaveLength(1)
    expect(existsSync(join(dataDir, MIGRATION_FILE))).toBe(false)
    expect(readdirSync(dataDir).filter((f) => f.includes('rejoin') || f === PENDING_FILE || f === CANDIDATE_FILE)).toEqual([])
    expect(await noteAfterUnlock()).toEqual({ text: 'SECRET-NOTE', epoch: 1 })
  })

  it('with sync: the rotated header goes to the remote by compare-and-swap, then the record drives the re-push', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const next = await rotate(new Migration(deps({ remote: () => remote })), ring)
    expect(await remoteHeader(remote)).toMatchObject({ keyEpoch: 1, revision: 2 })
    expect(await readRekeyRecord(dataDir)).toMatchObject({ kind: 'rekey', rekey: 'rotate', step: 'repush', fromEpoch: 0, toEpoch: 1 })
    next.close()
  })

  it('a header changed on another device meanwhile stops the rotation before anything local changed', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const m = new Migration(deps({ remote: () => remote }))
    const { recoveryKey } = await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))
    expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
    // Another device changes the password first (revision 2 on the remote).
    const base = await remoteHeader(remote)
    const proof = await proveSecret(base, { password: secretBytes(PASSWORD) }, weak)
    const elsewhere = await changePassword(base, ring.get('mk'), proof, secretBytes('a password set elsewhere'), weak)
    destroyKey(proof.kek)
    expect(await remote.writeHeader(elsewhere, (await remote.read()).version)).toBe(true)
    await expect(m.runRekey(ring)).rejects.toThrow(/Another device changed the vault/)
    expect(ring.isOpen).toBe(true)
    expect(header()).toMatchObject({ keyEpoch: 0, revision: 1 })
    expect(existsSync(join(dataDir, MIGRATION_FILE))).toBe(false)
    expect(readdirSync(dataDir).filter((f) => f.includes('rejoin') || f === PENDING_FILE || f === CANDIDATE_FILE)).toEqual([])
    closeOpened()
    ring.close()
    expect(databases()).toHaveLength(1)
    expect(await noteAfterUnlock()).toEqual({ text: 'SECRET-NOTE', epoch: 0 })
  })

  it('D-7 (review C9 L3): only a device record carrying the key-epoch capability lets a rekey run', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const records = [
      { name: 'Laptop', appVersion: '0.2.1', epochs: 1 },
      { name: 'Old desktop', appVersion: '0.1.4' },
      // A release number alone proves nothing (development builds report 0.1.0, a C5-only build 0.2.0).
      { name: 'Same version, no capability', appVersion: '0.2.0' },
      { name: 'A device record Slate cannot read' },
    ]
    const m = new Migration(deps({ remote: () => remote, devices: async () => records }))
    const err = String(await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD)).catch((e: unknown) => e))
    expect(err).toMatch(/Old desktop \(0\.1\.4\)/)
    expect(err).toMatch(/Same version, no capability/)
    expect(err).toMatch(/cannot read/)
    expect(err).not.toMatch(/Laptop/)
    const ok = new Migration(deps({ remote: () => remote, devices: async () => [{ name: 'Laptop', appVersion: '0.1.0', epochs: 1 }] }))
    await expect(ok.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))).resolves.toMatchObject({ recoveryKey: expect.any(String) })
    ok.discard()
    ring.close()
  })

  it('review C9 M3: the lock discards a prepared key change; running it then asks for the password again', async () => {
    const ring = await encrypted()
    const before = liveHandles()
    const m = new Migration(deps())
    const { recoveryKey } = await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))
    expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
    expect(liveHandles()).toBeGreaterThan(before)
    // What the lock sequence does (index.ts closeKeys), before the ring goes.
    m.discard()
    expect(liveHandles()).toBe(before)
    await expect(m.runRekey(ring)).rejects.toThrow(/recovery key first/)
    expect(header()).toMatchObject({ keyEpoch: 0 })
    ring.close()
  })

  it('a wrong password builds nothing', async () => {
    const ring = await encrypted()
    await expect(new Migration(deps()).prepareRekey(ring, 'rotate', secretBytes('not the password at all'))).rejects.toThrow()
    expect(header()).toMatchObject({ keyEpoch: 0 })
    ring.close()
  })

  for (const step of REKEY_STEPS.slice(0, 7) as RekeyStep[]) {
    for (const route of ['password', 'quick unlock'] as const) {
      it(`criterion 2: a crash before ${step} recovers (${route}): the notes, one epoch, and the record until the clean-up`, async () => {
        const remote = gitRemote()
        const ring = await encrypted(remote)
        const notes = (await notesUnder(dataDir, () => ({ password: secretBytes(PASSWORD) }), weak))!
        const withRing = liveHandles()
        const m = new Migration(deps({ remote: () => remote, crashAt: step }))
        const { recoveryKey } = await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))
        expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
        await expect(m.runRekey(ring)).rejects.toThrow(`Injected crash before ${step}`)
        closeOpened()
        if (ring.isOpen) ring.close()
        const old = { label: 'password', secret: () => ({ password: secretBytes(PASSWORD) }) }
        await expectNotesSurviveCrash(dataDir, { old, next: [{ label: 'new recovery key', secret: () => ({ recoveryKey: secretBytes(recoveryKey) }) }], notes, opts: weak })
        // No key of either epoch is left in the module, whichever step it stopped at (review C4 M2).
        expect(liveHandles()).toBeLessThanOrEqual(withRing - 9)
        const committed = ((await remoteHeader(remote)) as VaultHeaderV2).keyEpoch === 1
        expect(committed).toBe(step !== 'remote')
        // The sync check sees the remote's newer keys (keeping them as the candidate to follow).
        if (committed) {
          const checking = (await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)).keyRing
          try {
            await checkRemoteVault({ remote, dataDir, keyRing: checking, opts: weak })
          } catch (e) {
            if (!(e instanceof VaultSyncProblem)) throw e
          } finally {
            checking.close()
          }
        }
        const u = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
        const runner = new Migration(deps({ remote: () => remote }))
        let ring2 = u.keyRing
        if (route === 'password' && u.adopt) ring2 = await runner.rejoin(u.keyRing, { password: secretBytes(PASSWORD) }, u.adopt)
        // Review C9 H1: quick unlock carries no password, so it cannot follow at once; the record must survive it.
        let record = await runner.resumeRekeyAtUnlock(ring2)
        if (route === 'quick unlock' && ring2.schedule.suite === 2 && ring2.schedule.keyEpoch === 0 && committed) {
          expect(record?.step).toBe('committed')
          // Later, from the banner: the password follows the rotation and the record moves on to the re-push.
          ring2 = await runner.rejoin(ring2, { password: secretBytes(PASSWORD) })
          record = await runner.resumeRekeyAtUnlock(ring2)
        }
        closeOpened()
        ring2.close()
        expect(ring2.schedule).toMatchObject({ keyEpoch: committed ? 1 : 0 })
        if (committed) expect(record?.step).toBe('repush')
        else expect(record).toBeNull()
        expect(databases()).toHaveLength(1)
        expect(await noteAfterUnlock()).toEqual({ text: 'SECRET-NOTE', epoch: committed ? 1 : 0 })
      })
    }
  }
})

describe('PQ-B1: a header-v3 vault at a later key epoch', () => {
  it('T-PQ-B1-10: unlock reads a v3 header’s keyEpoch; keysInfo reports it; v2 is then below the floor; PQ-B4: rotating it keeps v3', async () => {
    const ring = await encrypted(null, CLOSED_GATE)
    const next = await rotate(new Migration(deps()), ring)
    const v2 = header() as VaultHeaderV2
    expect(v2.keyEpoch).toBe(1)
    writeFileSync(join(dataDir, VAULT_FILE), JSON.stringify(buildHeaderV3From(v2, next.get('mk'))))
    next.close()
    expect(await noteAfterUnlock()).toEqual({ text: 'SECRET-NOTE', epoch: 1 })
    // Unlocking v3 raised the signed floor to version 3 (INV-PQ-4): the v2 copy no longer opens.
    expect(JSON.parse(readFileSync(join(dataDir, PROFILE_FLOOR_FILE), 'utf8'))).toMatchObject({ minHeaderVersion: 3 })
    const { keyRing } = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    const m = new Migration(deps())
    expect(await m.keysInfo(keyRing)).toMatchObject({ headerVersion: 3, keyEpoch: 1, canRotate: true, canUpgrade: false })
    expect(header()).toMatchObject({ version: 3, keyEpoch: 1 })
    // Before PQ-B4 a rotation was refused here; since, a v3 vault is rotated into a v3 header, never a v2 one.
    const v2Copy = join(dir, 'v2')
    cpSync(dataDir, v2Copy, { recursive: true })
    writeFileSync(join(v2Copy, VAULT_FILE), JSON.stringify(v2))
    await expect(unlockVault(v2Copy, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow()
    const rotated = await rotate(m, keyRing)
    expect(header()).toMatchObject({ version: 3, keyEpoch: 2, pq: { kem: 'hybrid-only', minCapability: 1 } })
    rotated.close()
    expect(await noteAfterUnlock()).toEqual({ text: 'SECRET-NOTE', epoch: 2 })
    const again = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    await expect(new Migration(deps()).prepareRekey(again.keyRing, 'upgrade', secretBytes(PASSWORD))).rejects.toThrow(RotationRefused)
    again.keyRing.close()
  })
})

describe('C9 R-2: Replace history (git)', () => {
  it('after the key change has synced, the branch becomes one parentless commit of the same tree', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const m = new Migration(deps({ remote: () => remote }))
    const next = await rotate(m, ring)
    const dbFile = join(dataDir, databases()[0]!)
    await expect(m.replaceHistory(next, dbFile)).rejects.toThrow(/finish syncing/)
    rmSync(join(dataDir, MIGRATION_FILE))
    const inBare = (...args: string[]) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' }).trim()
    const tree = inBare('rev-parse', 'main^{tree}')
    expect(Number(inBare('rev-list', '--count', 'main'))).toBeGreaterThan(1)
    await m.replaceHistory(next, dbFile)
    opened.splice(0).forEach((o) => o.store.close())
    expect(inBare('rev-list', '--count', 'main')).toBe('1')
    expect(inBare('rev-parse', 'main^{tree}')).toBe(tree)
    next.close()
  })
})

describe('C9 R-2: re-push, sweep and prune after each sync', () => {
  const forgot: number[] = []
  // Review C9 L4: the superseded list belongs to the rekey that made it; set to the record's id where it should count.
  let listedBy = 'an aborted conversion'
  function outcome(over: Partial<SyncOutcome> & { stale?: number | null; oldReads?: number } = {}): SyncOutcome & { swept: string[][] } {
    const swept: string[][] = []
    let oldReads = over.oldReads ?? 0
    return {
      complete: true,
      drive: {
        staleFiles: () => (over.stale === undefined ? 2 : over.stale),
        takeOldReads: () => {
          const n = oldReads
          oldReads = 0
          return n
        },
        sweep: async (blobs, superseded) => {
          swept.push([...blobs, ...superseded])
          return { removed: 2, kept: 0 }
        },
      },
      localBlobs: async () => ['b.png'],
      superseded: async () => ({ id: listedBy, names: ['e2ee/d/listed'] }),
      clearSuperseded: async () => {},
      forgetPushed: async () => {
        forgot.push(1)
      },
      replaceable: true,
      swept,
      ...over,
    }
  }

  it('review C9 L4: a superseded list another rekey left (an aborted conversion) is never swept by this one', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const m = new Migration(deps({ remote: () => remote }))
    const next = await rotate(m, ring)
    expect(await m.afterSync(next, { ...outcome() })).toBe(true)
    listedBy = 'an aborted conversion'
    const sweep = outcome()
    expect(await m.afterSync(next, { ...sweep })).toBe(true)
    expect(sweep.swept).toEqual([['b.png']])
    next.close()
  })

  it('repush → sweep (after a sync that read nothing old) → prune, then history is empty on both sides', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const m = new Migration(deps({ remote: () => remote }))
    const next = await rotate(m, ring)
    expect(await m.afterSync(next, { ...outcome(), complete: false })).toBe(false)
    expect(await m.afterSync(next, { ...outcome() })).toBe(true)
    expect((await readRekeyRecord(dataDir))?.step).toBe('sweep')
    // A sync that pulled another device's notes through history: push everything again before sweeping.
    const first = outcome({ oldReads: 3 })
    expect(await m.afterSync(next, { ...first })).toBe(true)
    expect(first.swept).toEqual([])
    expect(forgot.length).toBeGreaterThan(0)
    listedBy = (await readRekeyRecord(dataDir))!.id
    const second = outcome()
    expect(await m.afterSync(next, { ...second })).toBe(true)
    expect(second.swept).toEqual([['b.png', 'e2ee/d/listed']])
    expect((await readRekeyRecord(dataDir))?.step).toBe('prune')
    // Stragglers seen again go back to the sweep; none left means history drops every epoch.
    expect(await m.afterSync(next, { ...outcome({ stale: 1 }) })).toBe(true)
    expect((await readRekeyRecord(dataDir))?.step).toBe('sweep')
    await m.afterSync(next, { ...outcome() })
    expect(await m.afterSync(next, { ...outcome({ stale: 0 }) })).toBe(false)
    expect(existsSync(join(dataDir, MIGRATION_FILE))).toBe(false)
    expect(((await remoteHeader(remote)) as VaultHeaderV2).history).toBeUndefined()
    expect((header() as VaultHeaderV2).history).toBeUndefined()
    expect(header()).toMatchObject({ keyEpoch: 1, revision: 3 })
    next.close()
  })

  for (const step of ['repush', 'sweep', 'prune'] as const) {
    it(`criterion 2: a crash before the ${step} step leaves the record where it was; the next sync carries on`, async () => {
      const remote = gitRemote()
      const ring = await encrypted(remote)
      const next = await rotate(new Migration(deps({ remote: () => remote })), ring)
        const ok = new Migration(deps({ remote: () => remote }))
      if (step !== 'repush') await ok.afterSync(next, { ...outcome() })
      if (step === 'prune') await ok.afterSync(next, { ...outcome() })
      const before = (await readRekeyRecord(dataDir))?.step
      const crashing = new Migration(deps({ remote: () => remote, crashAt: step }))
      await expect(crashing.afterSync(next, { ...outcome({ stale: step === 'prune' ? 0 : 2 }) })).rejects.toThrow(`Injected crash before ${step}`)
      expect((await readRekeyRecord(dataDir))?.step).toBe(before)
      for (let i = 0; i < 4 && existsSync(join(dataDir, MIGRATION_FILE)); i++) await ok.afterSync(next, { ...outcome({ stale: (await readRekeyRecord(dataDir))?.step === 'prune' ? 0 : 2 }) })
      expect(existsSync(join(dataDir, MIGRATION_FILE))).toBe(false)
      expect((header() as VaultHeaderV2).history).toBeUndefined()
      next.close()
    })
  }
})

describe('review C9 M5: a remote header is written only over the exact header this device last saw', () => {
  /** Unlocks `folder`, changes its password on the remote, closes. */
  async function changeOn(folder: string, remote: VaultRemote, from: string, to: string): Promise<void> {
    const u = await unlockVault(folder, { password: secretBytes(from) }, weak)
    try {
      await new Migration(deps({ remote: () => remote }, folder)).changePassword(u.keyRing, { password: secretBytes(from) }, secretBytes(to))
    } finally {
      u.keyRing.close()
    }
  }
  const opensRemote = async (remote: VaultRemote, password: string) => {
    try {
      destroyKey(await unlockWithPassword(await remoteHeader(remote), secretBytes(password), weak))
      return true
    } catch {
      return false
    }
  }

  for (const times of [1, 2]) {
    it(`a rotation made with sync off never overwrites another device's password change (${times} change${times === 1 ? '' : 's'})`, async () => {
      const remote = gitRemote()
      const ring = await encrypted(remote)
      const dataDirB = join(dir, 'data-b')
      cpSync(dataDir, dataDirB, { recursive: true })
      // A rotates with sync off, in a folder from an older build: no marker, no seen header, no clone.
      for (const f of [SEEN_FILE, SYNCED_FILE]) rmSync(join(dataDir, f), { force: true })
      const next = await rotate(new Migration(deps()), ring)
      next.close()
      // B changes the password on the remote, once or twice.
      await changeOn(dataDirB, remote, PASSWORD, 'B changed it once')
      if (times === 2) await changeOn(dataDirB, remote, 'B changed it once', 'B changed it twice')
      const bPassword = times === 2 ? 'B changed it twice' : 'B changed it once'
      // A turns sync on: the sync check never writes its header over B's.
      const a = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
      const err = await checkRemoteVault({ remote, dataDir, keyRing: a.keyRing, opts: weak }).catch((e: unknown) => e)
      expect(String(err)).toMatch(/Another device changed the vault/)
      expect(await opensRemote(remote, bPassword)).toBe(true)
      // Nor does A's own password change in Settings.
      await expect(new Migration(deps({ remote: () => remote })).changePassword(a.keyRing, { password: secretBytes(PASSWORD) }, secretBytes('A changed it again'))).rejects.toThrow(/Another device changed the vault/)
      a.keyRing.close()
      expect(await opensRemote(remote, bPassword)).toBe(true)
      expect(await remoteHeader(remote)).toMatchObject({ keyEpoch: 0, revision: 1 + times })
    })
  }

  it('two password changes racing: the first one wins, the other device is told to follow and then opens with it', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    await checkRemoteVault({ remote, dataDir, keyRing: ring, opts: weak })
    ring.close()
    const dataDirB = join(dir, 'data-b')
    cpSync(dataDir, dataDirB, { recursive: true })
    await changeOn(dataDir, remote, PASSWORD, 'A changed it first')
    await expect(changeOn(dataDirB, remote, PASSWORD, 'B changed it second')).rejects.toThrow(/Another device changed the vault/)
    expect(await opensRemote(remote, 'A changed it first')).toBe(true)
    expect(await opensRemote(remote, 'B changed it second')).toBe(false)
    // B's sync check keeps A's header as the pending one; B then opens with A's password, through it.
    const b = await unlockVault(dataDirB, { password: secretBytes(PASSWORD) }, weak)
    expect(await problemOf(checkRemoteVault({ remote, dataDir: dataDirB, keyRing: b.keyRing, opts: weak }))).toBeNull()
    expect(existsSync(join(dataDirB, PENDING_FILE))).toBe(true)
    b.keyRing.close()
    const followed = await unlockVault(dataDirB, { password: secretBytes('A changed it first') }, weak)
    expect(followed.passwordChanged).toBe(true)
    followed.keyRing.close()
  })

  it('a vault that has synced is not rekeyed with sync off, even without the marker file', async () => {
    const ring = await encrypted()
    await expect(new Migration(deps({ syncedBefore: async () => true })).prepareRekey(ring, 'rotate', secretBytes(PASSWORD))).rejects.toThrow(/turn sync on/i)
    ring.close()
  })
})

const problemOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof VaultSyncProblem ? e.problem : `other: ${String(e)}`))

describe('review C9 L5: one stale or replayed read never drops a committed key change', () => {
  it('a replayed older header keeps the record; the real one then lets the device follow', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const old = await remoteHeader(remote)
    const snap = join(dir, 'data-snap')
    const dying: VaultRemote = {
      read: () => remote.read(),
      claim: (h, v) => remote.claim(h, v),
      writeHeader: async (h, v) => {
        const ok = await remote.writeHeader(h, v)
        cpSync(dataDir, snap, { recursive: true })
        throw new Error(`killed after the write (${ok})`)
      },
    }
    const m = new Migration(deps({ remote: () => dying }))
    const { recoveryKey } = await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))
    expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
    await expect(m.runRekey(ring)).rejects.toThrow('killed')
    closeOpened()
    if (ring.isOpen) ring.close()
    const landed = await remoteHeader(remote)
    expect(landed).toMatchObject({ keyEpoch: 1 })
    // A hostile or stale remote shows the old header once.
    const replaying: VaultRemote = { read: async () => ({ header: old, version: 'stale', otherFiles: [] }), claim: async () => false, writeHeader: async () => false }
    const u = await unlockVault(snap, { password: secretBytes(PASSWORD) }, weak)
    expect(u.adopt).toMatchObject({ keyEpoch: 1 })
    expect(await new Migration(deps({ remote: () => replaying }, snap)).mayAdopt(u.adopt!, u.keyRing)).toBe(false)
    expect((await readRekeyRecord(snap))?.step).toBe('committed')
    expect(existsSync(join(snap, CANDIDATE_FILE))).toBe(true)
    // The real remote: the device follows its own change.
    const runner = new Migration(deps({ remote: () => remote }, snap))
    expect(await runner.mayAdopt(u.adopt!, u.keyRing)).toBe(true)
    const next = await runner.rejoin(u.keyRing, { password: secretBytes(PASSWORD) }, u.adopt)
    expect((await runner.resumeRekeyAtUnlock(next))?.step).toBe('repush')
    closeOpened()
    next.close()
  })
})

describe('review C9 M4: this device’s own unpublished key change never wins over the remote', () => {
  it('P5: killed inside its remote write, it restarts after another device changed the password; that password survives', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const dataDirB = join(dir, 'data-b')
    cpSync(dataDir, dataDirB, { recursive: true })
    const snap = join(dir, 'data-snap')
    // A's process dies in the remote write: the folder as it was then (candidate and `committed` record on disk).
    const dying: VaultRemote = {
      read: () => remote.read(),
      claim: (h, v) => remote.claim(h, v),
      writeHeader: async () => {
        cpSync(dataDir, snap, { recursive: true })
        throw new Error('killed')
      },
    }
    const m = new Migration(deps({ remote: () => dying }))
    const { recoveryKey } = await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))
    expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
    await expect(m.runRekey(ring)).rejects.toThrow('killed')
    closeOpened()
    if (ring.isOpen) ring.close()
    expect((await readRekeyRecord(snap))?.step).toBe('committed')
    // Meanwhile B changes the password (revision 2, epoch 0).
    const b = await unlockVault(dataDirB, { password: secretBytes(PASSWORD) }, weak)
    await new Migration(deps({ remote: () => remote }, dataDirB)).changePassword(b.keyRing, { password: secretBytes(PASSWORD) }, secretBytes('B changed it'))
    b.keyRing.close()
    // A restarts from the snapshot: the remote is checked before its own candidate is adopted.
    const runner = new Migration(deps({ remote: () => remote }, snap))
    const u = await unlockVault(snap, { password: secretBytes(PASSWORD) }, weak)
    let ringA = u.keyRing
    if (u.adopt && (await runner.mayAdopt(u.adopt, u.keyRing))) ringA = await runner.rejoin(u.keyRing, { password: secretBytes(PASSWORD) }, u.adopt)
    await runner.resumeRekeyAtUnlock(ringA)
    await checkRemoteVault({ remote, dataDir: snap, keyRing: ringA, opts: weak }).catch(() => {})
    closeOpened()
    expect(ringA.schedule).toMatchObject({ keyEpoch: 0 })
    ringA.close()
    expect(await readRekeyRecord(snap)).toBeNull()
    expect(existsSync(join(snap, CANDIDATE_FILE))).toBe(false)
    const theirs = await remoteHeader(remote)
    expect(theirs).toMatchObject({ revision: 2, keyEpoch: 0 })
    destroyKey(await unlockWithPassword(theirs, secretBytes('B changed it'), weak))
    await expect(unlockWithPassword(theirs, secretBytes(PASSWORD), weak)).rejects.toThrow()
  })

  it('a synced vault is not rekeyed with sync off, or with the remote out of reach', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    await checkRemoteVault({ remote, dataDir, keyRing: ring, opts: weak })
    await expect(new Migration(deps({ remote: () => null })).prepareRekey(ring, 'rotate', secretBytes(PASSWORD))).rejects.toThrow(/sync/i)
    const offline: VaultRemote = { read: async () => Promise.reject(new Error('offline')), claim: async () => false, writeHeader: async () => false }
    await expect(new Migration(deps({ remote: () => offline })).prepareRekey(ring, 'rotate', secretBytes(PASSWORD))).rejects.toThrow(/reach|offline/i)
    expect(header()).toMatchObject({ keyEpoch: 0 })
    ring.close()
  })
})

describe('C9 criterion 3: a device that missed the rotation', () => {
  it('stops syncing, then unlocks with its password through the pending header and follows', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    // B: the same vault on another computer, before the rotation.
    const dataDirB = join(dir, 'data-b')
    cpSync(dataDir, dataDirB, { recursive: true })
    const next = await rotate(new Migration(deps({ remote: () => remote })), ring)
    next.close()
    const b = await unlockVault(dataDirB, { password: secretBytes(PASSWORD) }, weak)
    expect(b.adopt).toBeUndefined()
    await expect(checkRemoteVault({ remote, dataDir: dataDirB, keyRing: b.keyRing, opts: weak })).rejects.toMatchObject({ problem: 'keys-changed' })
    expect(existsSync(join(dataDirB, CANDIDATE_FILE))).toBe(true)
    expect(existsSync(join(dataDirB, PENDING_FILE))).toBe(false)
    b.keyRing.close()
    const again = await unlockVault(dataDirB, { password: secretBytes(PASSWORD) }, weak)
    expect(again.adopt).toMatchObject({ keyEpoch: 1 })
    const followed = await new Migration(deps({ remote: () => remote }, dataDirB)).rejoin(again.keyRing, { password: secretBytes(PASSWORD) }, again.adopt)
    closeOpened()
    expect(followed.schedule).toMatchObject({ keyEpoch: 1 })
    followed.close()
    expect(header(dataDirB)).toMatchObject({ keyEpoch: 1 })
    expect(await noteAfterUnlock(dataDirB)).toEqual({ text: 'SECRET-NOTE', epoch: 1 })
  })

  it('when the password changed with the rotation, the new password opens its keys through history', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const dataDirB = join(dir, 'data-b')
    cpSync(dataDir, dataDirB, { recursive: true })
    const m = new Migration(deps({ remote: () => remote }))
    const next = await rotate(m, ring)
    await m.changePassword(next, { password: secretBytes(PASSWORD) }, secretBytes('the brand new password'))
    next.close()
    const pending: VaultHeader = await remoteHeader(remote)
    cpSync(join(dataDir, VAULT_FILE), join(dataDirB, CANDIDATE_FILE))
    expect(pending.revision).toBe(3)
    const b = await unlockVault(dataDirB, { password: secretBytes('the brand new password') }, weak)
    expect(b.adopt).toMatchObject({ keyEpoch: 1 })
    expect(b.keyRing.schedule).toMatchObject({ keyEpoch: 0 })
    const followed = await new Migration(deps({ remote: () => remote }, dataDirB)).rejoin(b.keyRing, { password: secretBytes('the brand new password') }, b.adopt)
    closeOpened()
    followed.close()
    expect(await noteAfterUnlock(dataDirB, 'the brand new password')).toEqual({ text: 'SECRET-NOTE', epoch: 1 })
  })

  it('a remote header write from a device that missed the rotation is refused, never a fork', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    const dataDirB = join(dir, 'data-b')
    cpSync(dataDir, dataDirB, { recursive: true })
    const next = await rotate(new Migration(deps({ remote: () => remote })), ring)
    next.close()
    const b = await unlockVault(dataDirB, { password: secretBytes(PASSWORD) }, weak)
    await expect(new Migration(deps({ remote: () => remote }, dataDirB)).changePassword(b.keyRing, { password: secretBytes(PASSWORD) }, secretBytes('a password set on B'))).rejects.toThrow(/changed on another device/)
    b.keyRing.close()
    expect(await remoteHeader(remote)).toMatchObject({ keyEpoch: 1, revision: 2 })
  })
})

describe('C9 R-5: a header-v1 vault upgrades to v2 by a rotation', () => {
  const FIXTURES = join(__dirname, 'fixtures', 'c4')
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as { password: string; envelopes: Record<string, string> }

  for (const step of REKEY_STEPS.slice(0, 7) as RekeyStep[]) {
    it(`criterion 2: an upgrade cut short before ${step} leaves a vault the password opens, with its notes`, async () => {
      cpSync(join(FIXTURES, 'data'), dataDir, { recursive: true })
      const pw = () => secretBytes(manifest.password)
      const u = await unlockVault(dataDir, { password: pw() }, weak)
      const rowsBefore = storeWithLk(u.keyRing, u.dbFile)
      const docs = rowsBefore.list('').length
      rowsBefore.close()
      const m = new Migration(deps({ crashAt: step }))
      const { recoveryKey } = await m.prepareRekey(u.keyRing, 'upgrade', pw())
      await m.confirmRecovery(secretBytes(recoveryKey))
      await expect(m.runRekey(u.keyRing)).rejects.toThrow(`Injected crash before ${step}`)
      closeOpened()
      if (u.keyRing.isOpen) u.keyRing.close()
      await expectNotesSurviveCrash(dataDir, {
        old: { label: 'password', secret: () => ({ password: pw() }) },
        next: [{ label: 'new recovery key', secret: () => ({ recoveryKey: secretBytes(recoveryKey) }) }],
        notes: docs,
        opts: weak,
      })
      const again = await unlockVault(dataDir, { password: pw() }, weak)
      const store = storeWithLk(again.keyRing, again.dbFile)
      expect(store.list('').length).toBe(docs)
      store.close()
      again.keyRing.close()
      expect(databases()).toHaveLength(1)
    })
  }

  it('keeps reading its suite-0x01 files through history epoch 0 and writes header v3 (PQ-B4: the gate is open) and local-keys v2', async () => {
    cpSync(join(FIXTURES, 'data'), dataDir, { recursive: true })
    const u = await unlockVault(dataDir, { password: secretBytes(manifest.password) }, weak)
    expect(header()).toMatchObject({ version: 1 })
    const m = new Migration(deps())
    const { recoveryKey } = await m.prepareRekey(u.keyRing, 'upgrade', secretBytes(manifest.password))
    expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
    const next = await m.runRekey(u.keyRing)
    opened.splice(0).forEach((o) => o.store.close())
    expect(header()).toMatchObject({ version: 3, suite: 2, keyEpoch: 1, profile: 'standard', pq: { kem: 'hybrid-only', minCapability: 1 } })
    expect(JSON.parse(readFileSync(join(dataDir, LOCAL_KEYS_FILE), 'utf8'))).toMatchObject({ version: 2, keyEpoch: 1 })
    const old = next.epochKeys(0)!
    expect(old.schedule.suite).toBe(SUITE.HKDF_AES256GCM)
    for (const [file, path] of Object.entries(manifest.envelopes)) {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES, file)))
      expect(() => openEnvelope({ syncKey: old.get('sync'), suite: SUITE.HKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites }, path, bytes)).not.toThrow()
    }
    next.close()
    // A second upgrade is refused; a rotation is the next step.
    const again = await unlockVault(dataDir, { password: secretBytes(manifest.password) }, weak)
    await expect(m.prepareRekey(again.keyRing, 'upgrade', secretBytes(manifest.password))).rejects.toThrow(/already/)
    again.keyRing.close()
  })
})

describe('PQ-B4: v1 vaults and new vaults land on v3 (roadmap §3.6)', () => {
  const FIXTURES = join(__dirname, 'fixtures', 'c4')
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as { password: string }
  const pw = () => secretBytes(manifest.password)

  async function v1Fixture(): Promise<{ ring: KeyRing; docs: number }> {
    cpSync(join(FIXTURES, 'data'), dataDir, { recursive: true })
    const u = await unlockVault(dataDir, { password: pw() }, weak)
    const store = storeWithLk(u.keyRing, u.dbFile)
    const docs = store.list('').length
    store.close()
    return { ring: u.keyRing, docs }
  }

  it('T-PQ-B4-01: with the gate open, a header-v1 vault’s upgrade writes v3 to the remote in one compare-and-swap', async () => {
    const { ring, docs } = await v1Fixture()
    const c = counted(gitRemote())
    const m = new Migration(deps({ remote: () => c.remote, devices: async () => PQ_DEVICES }))
    const { recoveryKey } = await m.prepareRekey(ring, 'upgrade', pw())
    expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
    const next = await m.runRekey(ring)
    opened.splice(0).forEach((o) => o.store.close())
    next.close()
    expect(c.writes()).toBe(1)
    const v3 = { version: 3, keyEpoch: 1, profile: 'standard', pq: { kem: 'hybrid-only', minCapability: 1 } }
    expect(await remoteHeader(c.remote)).toMatchObject(v3)
    expect(header()).toMatchObject(v3)
    expect(await readRekeyRecord(dataDir)).toMatchObject({ rekey: 'upgrade', step: 'repush', fromEpoch: 0, toEpoch: 1 })
    expect(JSON.parse(readFileSync(join(dataDir, PROFILE_FLOOR_FILE), 'utf8'))).toMatchObject({ minHeaderVersion: 3 })
    expect(await notesUnder(dataDir, () => ({ recoveryKey: secretBytes(recoveryKey) }), weak)).toBe(docs)
  })

  for (const step of REKEY_STEPS.slice(0, 7) as RekeyStep[]) {
    it(`T-PQ-B4-01: an upgrade to v3 cut short before ${step} leaves the notes to the old and the new secret`, async () => {
      const { ring, docs } = await v1Fixture()
      const remote = gitRemote()
      const m = new Migration(deps({ remote: () => remote, devices: async () => PQ_DEVICES, crashAt: step }))
      const { recoveryKey } = await m.prepareRekey(ring, 'upgrade', pw())
      expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
      await expect(m.runRekey(ring)).rejects.toThrow(`Injected crash before ${step}`)
      closeOpened()
      if (ring.isOpen) ring.close()
      // What reached the remote, if anything, is v3: no v2 header is ever published on the way.
      const snap = (await remote.read()).header
      if (snap !== null) expect(parseHeader(snap, weak)).toMatchObject({ version: 3, keyEpoch: 1 })
      expect(snap !== null).toBe(step !== 'remote')
      await expectNotesSurviveCrash(dataDir, {
        old: { label: 'password', secret: () => ({ password: pw() }) },
        next: [{ label: 'new recovery key', secret: () => ({ recoveryKey: secretBytes(recoveryKey) }) }],
        notes: docs,
        opts: weak,
      })
    })
  }

  it('T-PQ-B4-02: with the gate closed the upgrade lands on v2, and the PQ-B3 upgrade raises it to v3 once the key change has synced', async () => {
    const { ring } = await v1Fixture()
    const remote = gitRemote()
    let devices = OLD_DEVICES
    const m = new Migration(deps({ remote: () => remote, devices: async () => devices }))
    const { recoveryKey } = await m.prepareRekey(ring, 'upgrade', pw())
    expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
    const next = await m.runRekey(ring)
    opened.splice(0).forEach((o) => o.store.close())
    expect(header()).toMatchObject({ version: 2, keyEpoch: 1 })
    expect(await remoteHeader(remote)).toMatchObject({ version: 2, keyEpoch: 1 })
    devices = PQ_DEVICES
    const up = { dataDir, kdfOpts: weak, keyRing: next, remote: () => remote, devices: async () => devices, selfTest: async () => true }
    // The rekey record owns migration.json until its re-push, sweep and prune are done: the upgrade waits for them.
    const record = readFileSync(join(dataDir, MIGRATION_FILE), 'utf8')
    expect(await runPqUpgrade(up)).toEqual({ state: 'retry' })
    expect(readFileSync(join(dataDir, MIGRATION_FILE), 'utf8')).toBe(record)
    expect(header()).toMatchObject({ version: 2 })
    rmSync(join(dataDir, MIGRATION_FILE))
    expect(await runPqUpgrade(up)).toEqual({ state: 'done' })
    next.close()
    expect(header()).toMatchObject({ version: 3, keyEpoch: 1 })
    expect(await remoteHeader(remote)).toMatchObject({ version: 3, keyEpoch: 1 })
    expect(await notesUnder(dataDir, () => ({ password: pw() }), weak)).not.toBeNull()
  })

  it('T-PQ-B4-03: a new vault is v3 with sync off; v2 with a remote whose device records lack pq; v3 when they all carry it', async () => {
    const ring = await encrypted()
    ring.close()
    expect(header()).toMatchObject({ version: 3, revision: 1, keyEpoch: 0, pq: { kem: 'hybrid-only', minCapability: 1 } })
    expect(await noteAfterUnlock()).toEqual({ text: 'SECRET-NOTE', epoch: 0 })

    for (const [name, devices, version] of [
      ['old', OLD_DEVICES, 2],
      ['unreadable', null, 2],
      ['pq', PQ_DEVICES, 3],
    ] as const) {
      closeOpened()
      rmSync(dataDir, { recursive: true, force: true })
      bare = join(dir, `remote-${name}.git`)
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
      const remote = gitRemote(`vr-${name}`)
      const r = await encrypted(remote, {
        devices: async () => {
          if (devices === null) throw new Error('offline')
          return [...devices]
        },
      })
      r.close()
      expect(header()).toMatchObject({ version })
      expect(await remoteHeader(remote)).toMatchObject({ version })
      if (version === 2) expect(header()).not.toHaveProperty('pq')
    }
    // Sync off on a vault that has synced: its devices cannot be asked, so v2.
    closeOpened()
    rmSync(dataDir, { recursive: true, force: true })
    ;(await encrypted(null, CLOSED_GATE)).close()
    expect(header()).toMatchObject({ version: 2 })
  })

  it('T-PQ-B4-06: while a committed pq-header upgrade waits for an offline remote, no key change runs or touches its files', async () => {
    const remote = gitRemote()
    const ring = await encrypted(remote)
    expect(header()).toMatchObject({ version: 2 })
    const offline: VaultRemote = {
      read: () => Promise.reject(new Error('Could not resolve host')),
      claim: () => Promise.reject(new Error('Could not resolve host')),
      writeHeader: () => Promise.reject(new Error('Could not resolve host')),
    }
    const up = { dataDir, kdfOpts: weak, keyRing: ring, devices: async () => PQ_DEVICES, selfTest: async () => true }
    expect(await runPqUpgrade({ ...up, remote: () => offline })).toEqual({ state: 'retry' })
    const record = readFileSync(join(dataDir, MIGRATION_FILE), 'utf8')
    const candidate = readFileSync(join(dataDir, PQ_CANDIDATE_FILE), 'utf8')
    expect(JSON.parse(record)).toMatchObject({ kind: 'pq-header', step: 'committed' })
    const m = new Migration(deps({ remote: () => remote, devices: async () => PQ_DEVICES }))
    expect(await m.keysInfo(ring)).toMatchObject({ canRotate: false, canConvert: false, canUpgrade: false })
    for (const kind of ['rotate', 'upgrade', 'convert'] as const) {
      await expect(m.prepareRekey(ring, kind, secretBytes(PASSWORD), secretBytes('a much longer passphrase here'))).rejects.toThrow(/vault format update is still finishing/)
    }
    expect(readFileSync(join(dataDir, MIGRATION_FILE), 'utf8')).toBe(record)
    expect(readFileSync(join(dataDir, PQ_CANDIDATE_FILE), 'utf8')).toBe(candidate)
    expect(header()).toMatchObject({ version: 2 })
    // The remote is back: the upgrade finishes, and then the rotation runs (on v3).
    expect(await runPqUpgrade({ ...up, remote: () => remote })).toEqual({ state: 'done' })
    expect(await m.keysInfo(ring)).toMatchObject({ headerVersion: 3, canRotate: true })
    const next = await rotate(m, ring)
    next.close()
    expect(header()).toMatchObject({ version: 3, keyEpoch: 1 })
    expect(await remoteHeader(remote)).toMatchObject({ version: 3, keyEpoch: 1 })
  })

  it('T-PQ-B4-05: a v3 vault rotated with sync keeps v3 and pq on both sides, and a crash before each step loses no note', async () => {
    for (const step of [undefined, ...(REKEY_STEPS.slice(0, 7) as RekeyStep[])]) {
      closeOpened()
      rmSync(dataDir, { recursive: true, force: true })
      bare = join(dir, `remote-${step ?? 'none'}.git`)
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
      const remote = gitRemote(`vr-${step ?? 'none'}`)
      const ring = await encrypted(remote, { devices: async () => PQ_DEVICES })
      expect(header()).toMatchObject({ version: 3 })
      const notes = (await notesUnder(dataDir, () => ({ password: secretBytes(PASSWORD) }), weak))!
      const m = new Migration(deps({ remote: () => remote, devices: async () => PQ_DEVICES, ...(step ? { crashAt: step } : {}) }))
      const { recoveryKey } = await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))
      expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
      if (!step) {
        ;(await m.runRekey(ring)).close()
        closeOpened()
        const v3 = { version: 3, keyEpoch: 1, pq: { kem: 'hybrid-only', minCapability: 1 } }
        expect(header()).toMatchObject(v3)
        expect(await remoteHeader(remote)).toMatchObject(v3)
        continue
      }
      await expect(m.runRekey(ring)).rejects.toThrow(`Injected crash before ${step}`)
      closeOpened()
      if (ring.isOpen) ring.close()
      if (step !== 'remote') expect(await remoteHeader(remote)).toMatchObject({ version: 3, keyEpoch: 1 })
      await expectNotesSurviveCrash(dataDir, {
        old: { label: 'password', secret: () => ({ password: secretBytes(PASSWORD) }) },
        next: [{ label: 'new recovery key', secret: () => ({ recoveryKey: secretBytes(recoveryKey) }) }],
        notes,
        opts: weak,
      })
    }
  })
})
