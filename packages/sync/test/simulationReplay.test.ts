// FX-25: a simulation must replay. A failing plan is only worth its seed if playing it again does the same thing:
// the same boxes edited and deleted, the same syncs failing, the same documents at the end. The actions choose a box
// by its index in id order, so every id a run makes has to come from the plan too, or the "same" plan edits a
// different box each time and a nightly failure cannot be reproduced, shrunk or pinned.
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FUZZ_SEED, fcRuns } from '../../desktop/test/fuzz'
import { play, scenario } from './faultScenario'
import { NOTEBOOK, PAGE, simulate } from './simulation'

/** Plays of each plan. Two would show a difference; a third costs little and catches an id source that alternates. */
const REPLAYS = 3
// A plan here is three plays; the fault suite's own divisor would make this file as slow as that one.
const params = fcRuns(40, 25)

describe('replaying a simulation', () => {
  beforeAll(() => {
    // As in simulationFaults.test.ts: a stalled sync is aborted by a faked deadline.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  // About 10 ms a play on a quiet machine; 3 s a plan is a hundred times its three plays.
  it(`plays a generated fault plan the same way ${REPLAYS} times, over ${params.numRuns} plans`, { timeout: Math.max(120_000, params.numRuns * 3_000) }, async () => {
    let chose = 0
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const first = await play(s)
        for (let replay = 1; replay < REPLAYS; replay++) expect(await play(s), `replay ${replay}`).toEqual(first)
        // Only a plan that chose among several boxes could have chosen differently.
        const boxes = new Set(first.trace.flatMap((line) => /^box \S+ (\S+)$/.exec(line)?.[1] ?? []))
        if (boxes.size > 1 && first.trace.some((line) => /^(text|move|del) /.test(line))) chose++
      }),
      params
    )
    expect(chose, 'plans that chose among several boxes').toBeGreaterThan(params.numRuns / 2)
  })

  it('plays one seed of the three-device simulation to the same documents twice', { timeout: 120_000 }, async () => {
    const documents = async () => (await simulate(FUZZ_SEED, 120)).map((d) => [PAGE, NOTEBOOK].map((docId) => d.local.doc(docId).toJSON() as unknown))
    const first = await documents()
    expect(Object.keys((first[0]?.[0] as { boxes: object }).boxes).length, 'boxes on the page').toBeGreaterThan(1)
    expect(await documents()).toEqual(first)
  })
})
