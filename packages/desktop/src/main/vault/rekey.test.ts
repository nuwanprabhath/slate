// C9 (audit §4.7, §7.3 C9): key rotation and the v1→v2 upgrade through the resumable migration runner. Criterion 2:
// a crash injected before every step recovers; criterion 3: a device that missed the rotation unlocks with its
// password through the pending header and follows; R-2: re-push, sweep and prune, driven by `migration.json`.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveHandles } from '../../../test/vaultKeys'
import { secretBytes } from '../../shared/secret'
import { buildHeaderV3From, changePassword, proveSecret, RotationRefused, type VaultHeaderV2 } from './header'
import { Migration, MIGRATION_FILE, readRekeyRecord } from './migration'
import { destroyKey } from './native'
import { PROFILE_FLOOR_FILE } from './profileFloor'
import { CANDIDATE_FILE, LOCAL_KEYS_FILE, PENDING_FILE, unlockVault, VAULT_FILE } from './unlock'
import { bare, CLOSED_GATE, closeOpened, databases, dataDir, deps, dir, encrypted, gitRemote, header, noteAfterUnlock, opened, PASSWORD, remoteHeader, rotate, useRekeyHarness, weak } from '../../../test/rekeyHarness'

useRekeyHarness()

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
