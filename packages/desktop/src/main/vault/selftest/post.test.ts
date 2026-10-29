// T-POST-01, -03, -07 (audit §6.2, §6.9). Runs under `npm run test:main` on the real module the main-process
// tests share (testSetup.ts). A failure is sticky for the process, so the failure cases run the module in child
// processes (post.child.test.ts); here the state machine is driven with recording fakes.
import { describe, expect, it } from 'vitest'
import type { SlateNative } from '@slate/native'
import { dbModule } from '../../db/dbModule'
import { testHasProvider } from '../../db/testModule'
import { VaultStateMachine } from '../vaultState'
import { KAT_IDS, runPost, type KatId } from './post'
import { failClosed, startupSelfTest } from './supervisor'

describe('power-up self-test (T-POST-01)', () => {
  it('passes every KAT on an intact module, in KAT_IDS order, and leaves no key handle behind', async () => {
    const n = dbModule().native
    const before = n.status().liveHandles
    const r = await runPost({ native: n, requireFips: testHasProvider, exclusive: true })
    expect(r.failed).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.ran).toEqual([...KAT_IDS])
    expect(n.status().liveHandles).toBe(before)
    expect(n.status().errorState).toBe(false)
    // Criterion 3: under 50 ms on CI runners (budget 10 s); 1 s here leaves room for a loaded machine.
    expect(r.ms).toBeLessThan(1000)
  })

  it('T-PQ-A4-01: a full POST runs POST-MLDSA-VERIFY and passes', async () => {
    const r = await runPost({ native: dbModule().native, requireFips: testHasProvider })
    expect(r.ran).toContain('POST-MLDSA-VERIFY')
    expect(r.failed).toEqual([])
  })

  it('T-PQ-A4-03: the whole run, with the ML-DSA check, stays under the budget assertion', async () => {
    const r = await runPost({ native: dbModule().native, requireFips: testHasProvider })
    expect(r.ms).toBeLessThan(1000)
    expect(r.failed).not.toContain('POST-TIMEOUT')
  })

  it('runs one at a time: overlapping runs (on demand, before a vault change) each pass', async () => {
    const n = dbModule().native
    const runs = await Promise.all([1, 2, 3].map(() => runPost({ native: n, requireFips: testHasProvider })))
    expect(runs.map((r) => r.failed)).toEqual([[], [], []])
  })

  it('without a module it is POST-MODULE-LOAD, and nothing else runs', async () => {
    const r = await runPost({ native: null, requireFips: false })
    expect(r).toMatchObject({ ok: false, failed: ['POST-MODULE-LOAD'], ran: ['POST-MODULE-LOAD'], module: null })
  })
})

describe('the supervisor (T-POST-03, T-POST-07)', () => {
  const quiet = () => {}

  it('T-POST-03: a missing module is POST-MODULE-LOAD and the vault never leaves selftest-failed', async () => {
    const vault = new VaultStateMachine()
    let initial = 0
    const r = await startupSelfTest({ native: null, startProblem: null, requireFips: () => false, vault, initialState: () => (initial++, 'locked'), corrupt: null, passed: quiet, failed: quiet })
    expect(r.failed).toEqual(['POST-MODULE-LOAD'])
    expect(vault.state).toBe('selftest-failed')
    // S-1: the data folder was never looked at.
    expect(initial).toBe(0)
    for (const next of ['plaintext', 'locked', 'unlocking', 'unlocked', 'locking', 'migrating', 'selftest'] as const) expect(() => vault.to(next)).toThrow()
  })

  it('a module that failed its start-up checks (harden, init, provider) fails with that reason, before any KAT', async () => {
    const vault = new VaultStateMachine()
    // A stand-in: the error state is sticky, and the real module is shared by every test in this process.
    let errored = 0
    const native = { enterErrorState: () => (errored++, 0) } as unknown as SlateNative
    const r = await startupSelfTest({ native, startProblem: 'POST-MODULE-STATUS (SCC_15)', requireFips: () => true, vault, initialState: () => 'locked', corrupt: null, passed: quiet, failed: quiet })
    expect(errored).toBe(1)
    expect(r.failed).toEqual(['POST-MODULE-STATUS'])
    expect(r.ran).toEqual([])
    expect(vault.state).toBe('selftest-failed')
  })

  it('a passed POST hands over to the state the data folder gives, and logs it', async () => {
    const vault = new VaultStateMachine()
    const events: string[] = []
    const r = await startupSelfTest({
      native: dbModule().native,
      startProblem: null,
      requireFips: () => testHasProvider,
      vault,
      initialState: () => {
        // S-1: the data folder is read only after the POST passed.
        expect(vault.state).toBe('selftest')
        return 'plaintext'
      },
      corrupt: null,
      passed: () => void events.push('passed'),
      failed: () => void events.push('failed'),
    })
    expect(r.ok).toBe(true)
    expect(vault.state).toBe('plaintext')
    expect(events).toEqual(['passed'])
  })

  it('T-POST-07: a failure while unlocked flips the state before any slow step, then runs every step in order', async () => {
    const vault = new VaultStateMachine()
    vault.to('locked')
    vault.to('unlocking')
    vault.to('unlocked')
    const seen: string[] = []
    let errorState = false
    const native = { enterErrorState: () => ((errorState = true), 0 as const) }
    await failClosed(
      native,
      vault,
      {
        replaceWindowsWithErrorScreen: (failed) => void seen.push(`windows:${vault.state}:${failed.join(',')}:${String(errorState)}`),
        stopServices: async () => void seen.push(`services:${vault.state}`),
        stopUpdates: () => void seen.push(`updates:${vault.state}`),
        closeDatabases: () => void seen.push(`db:${vault.state}`),
        closeKeyRing: () => (seen.push(`keys:${vault.state}`), 0),
      },
      ['POST-AES-GCM-ENC' satisfies KatId],
    )
    expect(seen).toEqual(['windows:selftest-failed:POST-AES-GCM-ENC:true', 'services:selftest-failed', 'updates:selftest-failed', 'db:selftest-failed', 'keys:selftest-failed'])
  })

  it('S-8: every step runs even when an earlier one throws; a second failure runs nothing again', async () => {
    const vault = new VaultStateMachine()
    vault.to('plaintext')
    const seen: string[] = []
    const steps = {
      replaceWindowsWithErrorScreen: () => {
        seen.push('windows')
        throw new Error('window gone')
      },
      stopServices: () => {
        seen.push('services')
        return Promise.reject(new Error('sync stuck'))
      },
      closeDatabases: () => {
        seen.push('db')
        throw new Error('busy')
      },
      stopUpdates: () => {
        seen.push('updates')
        throw new Error('no network')
      },
      closeKeyRing: () => (seen.push('keys'), 0),
    }
    await failClosed(null, vault, steps, ['POST-MODULE-STATUS'])
    await failClosed(null, vault, steps, ['POST-MODULE-STATUS'])
    expect(seen).toEqual(['windows', 'services', 'updates', 'db', 'keys'])
    expect(vault.state).toBe('selftest-failed')
  })
})
