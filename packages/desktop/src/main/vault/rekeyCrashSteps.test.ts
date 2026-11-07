// C9 criterion 2 (audit §7.3 C9): a crash injected before each key-change step, by password and by quick unlock,
// recovers the notes with one epoch and keeps the record until the clean-up. Split from rekey.test.ts to run beside it.
import { describe, expect, it } from 'vitest'
import { liveHandles } from '../../../test/vaultKeys'
import { secretBytes } from '../../shared/secret'
import { type VaultHeaderV2 } from './header'
import { Migration, REKEY_STEPS, type RekeyStep } from './migration'
import { expectNotesSurviveCrash, notesUnder } from './testVault'
import { unlockVault } from './unlock'
import { checkRemoteVault, VaultSyncProblem } from './vaultCheck'
import { closeOpened, databases, dataDir, deps, encrypted, gitRemote, noteAfterUnlock, PASSWORD, remoteHeader, useRekeyHarness, weak } from '../../../test/rekeyHarness'

useRekeyHarness()

describe('C9 key rotation through the migration runner', () => {
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
