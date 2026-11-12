// C9 R-5 and PQ-B4 (audit §7.3 C9, roadmap §3.6): a header-v1 vault upgrades by a rotation, and v1 and new vaults
// land on header v3 when every device reads it.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { secretBytes } from '../../shared/secret'
import { openEnvelope } from './envelope'
import { parseHeader } from './header'
import type { KeyRing } from './keyring'
import { Migration, MIGRATION_FILE, readRekeyRecord, REKEY_STEPS, type RekeyStep } from './migration'
import { PROFILE_FLOOR_FILE } from './profileFloor'
import { PROFILES } from './profile'
import { type VaultRemote } from './remoteVault'
import { SUITE } from './suite'
import { expectNotesSurviveCrash, notesUnder, storeWithLk } from './testVault'
import { LOCAL_KEYS_FILE, unlockVault } from './unlock'
import { PQ_CANDIDATE_FILE, runPqUpgrade } from './pqUpgrade'
import { bare, CLOSED_GATE, closeOpened, counted, databases, dataDir, deps, dir, encrypted, gitRemote, header, noteAfterUnlock, OLD_DEVICES, opened, PASSWORD, PQ_DEVICES, remoteHeader, rotate, setBare, useRekeyHarness, weak } from '../../../test/rekeyHarness'

useRekeyHarness()

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
      await m.confirmRecovery(recoveryKey)
      await expect(m.runRekey(u.keyRing)).rejects.toThrow(`Injected crash before ${step}`)
      closeOpened()
      if (u.keyRing.isOpen) u.keyRing.close()
      await expectNotesSurviveCrash(dataDir, {
        old: { label: 'password', secret: () => ({ password: pw() }) },
        next: [{ label: 'new recovery key', secret: () => ({ recoveryKey: recoveryKey }) }],
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
    expect(await m.confirmRecovery(recoveryKey)).toBe(true)
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
    expect(await m.confirmRecovery(recoveryKey)).toBe(true)
    const next = await m.runRekey(ring)
    opened.splice(0).forEach((o) => o.store.close())
    next.close()
    expect(c.writes()).toBe(1)
    const v3 = { version: 3, keyEpoch: 1, profile: 'standard', pq: { kem: 'hybrid-only', minCapability: 1 } }
    expect(await remoteHeader(c.remote)).toMatchObject(v3)
    expect(header()).toMatchObject(v3)
    expect(await readRekeyRecord(dataDir)).toMatchObject({ rekey: 'upgrade', step: 'repush', fromEpoch: 0, toEpoch: 1 })
    expect(JSON.parse(readFileSync(join(dataDir, PROFILE_FLOOR_FILE), 'utf8'))).toMatchObject({ minHeaderVersion: 3 })
    expect(await notesUnder(dataDir, () => ({ recoveryKey: recoveryKey }), weak)).toBe(docs)
  })

  for (const step of REKEY_STEPS.slice(0, 7) as RekeyStep[]) {
    it(`T-PQ-B4-01: an upgrade to v3 cut short before ${step} leaves the notes to the old and the new secret`, async () => {
      const { ring, docs } = await v1Fixture()
      const remote = gitRemote()
      const m = new Migration(deps({ remote: () => remote, devices: async () => PQ_DEVICES, crashAt: step }))
      const { recoveryKey } = await m.prepareRekey(ring, 'upgrade', pw())
      expect(await m.confirmRecovery(recoveryKey)).toBe(true)
      await expect(m.runRekey(ring)).rejects.toThrow(`Injected crash before ${step}`)
      closeOpened()
      if (ring.isOpen) ring.close()
      // What reached the remote, if anything, is v3: no v2 header is ever published on the way.
      const snap = (await remote.read()).header
      if (snap !== null) expect(parseHeader(snap, weak)).toMatchObject({ version: 3, keyEpoch: 1 })
      expect(snap !== null).toBe(step !== 'remote')
      await expectNotesSurviveCrash(dataDir, {
        old: { label: 'password', secret: () => ({ password: pw() }) },
        next: [{ label: 'new recovery key', secret: () => ({ recoveryKey: recoveryKey }) }],
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
    expect(await m.confirmRecovery(recoveryKey)).toBe(true)
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
      setBare(join(dir, `remote-${name}.git`))
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

  // One case, one scenario per crash step, each a whole vault lifecycle: the harness's 30 s is a budget for one
  // scenario, so this case needs its own, or a loaded machine times it out mid-list. Measured under load average 18:
  // 1.1-3.3 s per scenario, so 15 s each leaves ~4x headroom and still fails fast on a real hang.
  const B4_05_STEPS = [undefined, ...(REKEY_STEPS.slice(0, 7) as RekeyStep[])]
  it('T-PQ-B4-05: a v3 vault rotated with sync keeps v3 and pq on both sides, and a crash before each step loses no note', async () => {
    for (const step of B4_05_STEPS) {
      closeOpened()
      rmSync(dataDir, { recursive: true, force: true })
      setBare(join(dir, `remote-${step ?? 'none'}.git`))
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
      const remote = gitRemote(`vr-${step ?? 'none'}`)
      const ring = await encrypted(remote, { devices: async () => PQ_DEVICES })
      expect(header()).toMatchObject({ version: 3 })
      const notes = (await notesUnder(dataDir, () => ({ password: secretBytes(PASSWORD) }), weak))!
      const m = new Migration(deps({ remote: () => remote, devices: async () => PQ_DEVICES, ...(step ? { crashAt: step } : {}) }))
      const { recoveryKey } = await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))
      expect(await m.confirmRecovery(recoveryKey)).toBe(true)
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
        next: [{ label: 'new recovery key', secret: () => ({ recoveryKey: recoveryKey }) }],
        notes,
        opts: weak,
      })
    }
  }, B4_05_STEPS.length * 15_000)
})
