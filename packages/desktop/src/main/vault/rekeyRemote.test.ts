// C9 against a remote (audit §7.3 C9): R-2 re-push, sweep and prune; header writes only over the header this device
// saw (M5); stale reads (L5) and unpublished changes (M4); criterion 3, a device that missed the rotation.
import { describe, expect, it } from 'vitest'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { secretBytes } from '../../shared/secret'
import { unlockWithPassword, type VaultHeader, type VaultHeaderV2 } from './header'
import { Migration, MIGRATION_FILE, readRekeyRecord, type SyncOutcome } from './migration'
import { destroyKey } from './native'
import { type VaultRemote } from './remoteVault'
import { CANDIDATE_FILE, PENDING_FILE, SYNCED_FILE, unlockVault, VAULT_FILE } from './unlock'
import { SEEN_FILE } from './seen'
import { checkRemoteVault, VaultSyncProblem } from './vaultCheck'
import { closeOpened, dataDir, deps, dir, encrypted, gitRemote, header, noteAfterUnlock, PASSWORD, remoteHeader, rotate, useRekeyHarness, weak } from '../../../test/rekeyHarness'

useRekeyHarness()

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
