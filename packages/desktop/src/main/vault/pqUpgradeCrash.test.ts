// PQ-B3 (roadmap §3.4, §3.5 step table): the upgrade cut short before each durable step, then a fresh unlock, always
// ends on header v3 (directly, or through the remote copy the next run adopts) with every note and every secret.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { secretBytes } from '../../shared/secret'
import { readJsonCapped } from './atomic'
import { parseHeader } from './header'
import { MIGRATION_FILE } from './migration'
import { PQ_CANDIDATE_FILE, PQ_UPGRADE_STEPS, runPqUpgrade, type PqUpgradeDeps } from './pqUpgrade'
import { memoryRemote, tempRoot, testDevice, TEST_PASSWORD, weak } from '../../../test/pqDevice'
import { writeSeen } from './seen'
import { expectNotesSurviveCrash } from './testVault'
import { unlockVault, VAULT_FILE } from './unlock'

vi.setConfig({ testTimeout: 120_000 })
const root = tempRoot('crash')
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('T-PQ-B3-03: an upgrade cut short at any step loses nothing', () => {
  for (const step of PQ_UPGRADE_STEPS) {
    it(`T-PQ-B3-03: a crash before ${step}, then a fresh unlock, ends on v3 with every note`, async () => {
      const d = await testDevice(root, 3)
      const mem = memoryRemote()
      expect(await mem.remote.writeHeader(d.header, null)).toBe(true)
      await writeSeen(d.dir, d.header)
      const deps = (ring: PqUpgradeDeps['keyRing'], crashAt?: (typeof PQ_UPGRADE_STEPS)[number]): PqUpgradeDeps => ({
        dataDir: d.dir,
        kdfOpts: weak,
        keyRing: ring,
        remote: () => mem.remote,
        devices: async () => [],
        selfTest: async () => true,
        ...(crashAt ? { crashAt } : {}),
      })
      await expect(runPqUpgrade(deps(d.ring, step))).rejects.toThrow(`Injected crash before ${step}`)
      d.ring.close()
      const secrets = {
        old: { label: 'password', secret: () => ({ password: secretBytes(TEST_PASSWORD) }) },
        next: [{ label: 'recovery key', secret: () => ({ recoveryKey: secretBytes(d.recoveryKey) }) }] as const,
        notes: 3,
        opts: weak,
      }
      // The crashed folder as it is, before any recovery.
      const crashed = `${d.dir}-as-crashed`
      cpSync(d.dir, crashed, { recursive: true })
      await expectNotesSurviveCrash(crashed, secrets)
      rmSync(crashed, { recursive: true, force: true })

      const again = await unlockVault(d.dir, { password: secretBytes(TEST_PASSWORD) }, weak)
      try {
        expect((await runPqUpgrade(deps(again.keyRing))).state).toBe('done')
      } finally {
        again.keyRing.close()
      }
      const h = parseHeader(await readJsonCapped(join(d.dir, VAULT_FILE)), weak)
      expect(h).toMatchObject({ version: 3, revision: d.header.revision + 1 })
      expect(parseHeader((await mem.remote.read()).header, weak)).toEqual(h)
      // One remote write for the claim, one for the upgrade, whatever step the crash came before.
      expect(mem.writes()).toBe(2)
      expect(existsSync(join(d.dir, MIGRATION_FILE))).toBe(false)
      expect(existsSync(join(d.dir, PQ_CANDIDATE_FILE))).toBe(false)
      await expectNotesSurviveCrash(d.dir, secrets)
    })
  }
})
