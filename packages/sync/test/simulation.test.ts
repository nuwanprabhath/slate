import { describe, it } from 'vitest'
import { expectConverged, simulate } from './simulation'

describe('three-device simulation', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    // Each seed takes about 1 s here and up to 18 s on a shared CI runner: the default 5 s cuts it off there.
    it(`converges for seed ${seed}`, { timeout: 60_000 }, async () => {
      expectConverged(await simulate(seed, 200))
    })
  }
})
