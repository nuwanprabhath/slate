// Fault-injection property test (review F8): three devices share one drive that refuses calls, loses answers, stalls,
// crashes the process, and omits, reorders or repeats delta items, at plan-chosen calls. After the faults stop and
// every device syncs to quiescence they must hold identical documents, with no local edit missing.
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FAULT_KINDS, noFaults } from './faultyDrive'
import { quiesce, run, scenario, syncWithFaults, totals, verify, world, type Dev, type Edited } from './faultScenario'
import { addTextBox, appendText, editPage } from './memoryLocal'
import { PAGE } from './simulation'

const RUNS = Number(process.env.SLATE_SIM_RUNS) || 500
const SEED = Number(process.env.SLATE_SIM_SEED) || 0x51a7e

describe('three devices over a faulty drive', () => {
  beforeAll(() => {
    // Only timeouts: the engine's clock and the microtask queue stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  // FX-24: what plan 2,571 of the fixed seed found, shrunk to its one fault and pinned, so the default 500 plans do
  // not have to reach it. d1 pushes an edit and its delta call is refused; the syncs it finishes afterwards have
  // nothing to push. An engine that still counts that edit as unsynced restores the box when the delete arrives in
  // the last round, where no round is left to push the copy.
  it('converges after a sync that pushed an edit and then lost its pull (FX-24)', async () => {
    const { devices } = world([{ calls: { 4: { kind: 'offline' } }, deltas: {} }, noFaults(), noFaults()])
    const [d1, d2] = devices as [Dev, Dev, Dev]
    const kept = editPage(d2.local, PAGE, (p) => addTextBox(p, 'kept'), 1000n)
    const doomed = editPage(d2.local, PAGE, (p) => addTextBox(p, 'doomed'), 1001n)
    const edited: Edited = { notes: [], boxes: new Map([[kept, ['kept']], [doomed, ['doomed', 'd1 ']]]), deleted: new Set([doomed]) }
    await syncWithFaults(d2)
    // d1's drive calls 0 to 2: its device record, the delta, the download of d2's chunk.
    await syncWithFaults(d1)
    editPage(d2.local, PAGE, (p) => p.deleteBox(doomed), 1002n)
    editPage(d1.local, PAGE, (p) => appendText(p, doomed, 'd1 '), 1003n)
    // Calls 3 and 4: the chunk upload lands, the delta is the refused call.
    expect(await syncWithFaults(d1)).toMatchObject({ status: 'offline', pushed: 1 })
    expect(d1.drive.fired.offline).toBe(1)

    await quiesce(devices)
    verify(devices, edited)
  })

  // 500 fast-check plans, each a whole three-device convergence; the seed is fixed, so what varies is the machine.
  // Measured over four runs at load average 23-27: 37.3, 39.6 and 51.5 s, and a fourth that hit the old
  // max(55 s, RUNS x 120 ms) = 60 s budget and failed. 480 ms per plan is 4x the per-plan cost at the quiet end and
  // ~2.4x at the loaded end of what completed; the floor keeps a smaller SLATE_SIM_RUNS honest too.
  it(`converge with no edit lost, over ${RUNS} generated fault plans`, { timeout: Math.max(110_000, RUNS * 480) }, async () => {
    await fc.assert(
      fc.asyncProperty(scenario, (s) => run(s)),
      { numRuns: RUNS, seed: SEED }
    )
    expect(totals.runs).toBe(RUNS)
    for (const kind of FAULT_KINDS) expect(totals.fired[kind], `${kind} fired`).toBeGreaterThan(0)
    expect(totals.aborted, 'stalled syncs aborted').toBeGreaterThan(0)
    expect(totals.restarted, 'engines restarted after a crash').toBeGreaterThan(0)
    expect(totals.compacted, 'runs that compacted').toBeGreaterThan(RUNS / 2)
  })
})
