// FX-25: a simulation must replay. A failing plan is only worth its seed if playing it again does the same thing:
// the same boxes edited and deleted, the same syncs failing, the same documents at the end. The actions choose a box
// by its index in id order, so every id a run makes has to come from the plan too, or the "same" plan edits a
// different box each time and a nightly failure cannot be reproduced, shrunk or pinned.
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FUZZ_SEED, fcRuns } from '../../desktop/test/fuzz'
import { play, scenario, type Scenario } from './faultScenario'
import { noFaults } from './faultyDrive'
import { NOTEBOOK, PAGE, simulate } from './simulation'

/** Plays of each plan. Two would show a difference; a third costs little and catches an id source that alternates. */
const REPLAYS = 3
// A plan here is three plays; the fault suite's own run count would make this file slower than that one.
const params = fcRuns(40, 25)

describe('replaying a simulation', () => {
  beforeAll(() => {
    // As in simulationFaults.test.ts: a stalled sync is aborted by a faked deadline.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  // Measured: 39 ms a plan (its three plays) over 4,000 plans; 4 s a plan is a hundred times that.
  it(`plays a generated fault plan the same way ${REPLAYS} times, over ${params.numRuns} plans`, { timeout: Math.max(120_000, params.numRuns * 4_000) }, async () => {
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

  // The engine names the copy it restores, and that copy is in the list the next action indexes. About 1 generated
  // plan in 60 restores a box, too few for the plans above to promise one, so this plan does: d1 edits a box that d2
  // deletes, and gets it back as a copy when it pulls the delete.
  it('gives the box the engine restores the same id on every play', async () => {
    const restoring: Scenario = {
      plans: [noFaults(), noFaults(), noFaults()],
      ids: 25,
      actions: [
        { op: 'box', dev: 1, pick: 0 },
        { op: 'box', dev: 1, pick: 1 },
        { op: 'sync', dev: 1, pick: 0 },
        { op: 'sync', dev: 0, pick: 0 },
        { op: 'text', dev: 0, pick: 0 },
        { op: 'del', dev: 1, pick: 0 },
        { op: 'sync', dev: 1, pick: 0 },
        { op: 'sync', dev: 0, pick: 0 }
      ]
    }
    const first = await play(restoring)
    expect(first.devices.map((d) => d.restored)).toEqual([1, 0, 0])
    for (let replay = 1; replay < REPLAYS; replay++) expect(await play(restoring), `replay ${replay}`).toEqual(first)
  })

  it('plays one seed of the three-device simulation to the same documents twice', { timeout: 120_000 }, async () => {
    const documents = async () => (await simulate(FUZZ_SEED, 120)).map((d) => [PAGE, NOTEBOOK].map((docId) => d.local.doc(docId).toJSON() as unknown))
    const first = await documents()
    expect(Object.keys((first[0]?.[0] as { boxes: object }).boxes).length, 'boxes on the page').toBeGreaterThan(1)
    expect(await documents()).toEqual(first)
  })
})
