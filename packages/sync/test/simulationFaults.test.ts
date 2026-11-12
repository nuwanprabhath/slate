// Fault-injection property test (review F8): three devices share one drive that refuses calls, loses answers, stalls,
// crashes the process, and omits, reorders or repeats delta items, at plan-chosen calls. After the faults stop and
// every device syncs to quiescence they must hold identical documents, with no local edit missing.
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FAULT_KINDS } from './faultyDrive'
import { run, scenario, totals } from './faultScenario'

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
