import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vaultNative } from './native'
import { PROFILES } from './profile'
import { canTryPassword, RefusalCoalescer, readThrottle, recordFailure, recordSuccess, sealThrottle, throttleSealIntact, writeThrottle, type ThrottleState } from './unlockThrottle'

const fips = PROFILES['fips-140-3']
const std = PROFILES.standard
const MIN = 60_000
const T0 = 1_700_000_000_000
const empty: ThrottleState = { failures: [], lockedUntil: null }

describe('unlock throttle (AC-7)', () => {
  it('T-POL-04: three failures within 15 minutes, then the fourth password attempt waits 180 minutes', () => {
    let s = empty
    for (const at of [0, 1, 2]) {
      expect(canTryPassword(s, fips, T0 + at * MIN)).toEqual({ allowed: true })
      s = recordFailure(s, fips, T0 + at * MIN)
    }
    expect(canTryPassword(s, fips, T0 + 3 * MIN)).toEqual({ allowed: false, retryAt: T0 + 2 * MIN + 180 * MIN })
    expect(canTryPassword(s, fips, T0 + 2 * MIN + 180 * MIN - 1).allowed).toBe(false)
    expect(canTryPassword(s, fips, T0 + 2 * MIN + 180 * MIN)).toEqual({ allowed: true })
  })

  it('T-POL-04: failures older than 15 minutes do not count', () => {
    let s = recordFailure(recordFailure(empty, fips, T0), fips, T0 + MIN)
    s = recordFailure(s, fips, T0 + 16 * MIN + 1)
    expect(s.lockedUntil).toBeNull()
    expect(s.failures).toEqual([T0 + 16 * MIN + 1])
  })

  it('T-POL-04: success resets the throttle', () => {
    const locked = [0, 1, 2].reduce((s, at) => recordFailure(s, fips, T0 + at * MIN), empty)
    expect(locked.lockedUntil).not.toBeNull()
    expect(recordSuccess()).toEqual(empty)
  })

  it('T-POL-04: the standard profile has no throttle', () => {
    const s = [0, 1, 2, 3, 4, 5].reduce((st, at) => recordFailure(st, std, T0 + at * MIN), empty)
    expect(s).toEqual(empty)
    expect(canTryPassword({ failures: [], lockedUntil: T0 + 999 * MIN }, std, T0)).toEqual({ allowed: true })
  })
})

describe('unlock-throttle.json', () => {
  const k = vaultNative().keyRandom()
  const dir = mkdtempSync(join(tmpdir(), 'slate-throttle-'))
  const path = join(dir, 'unlock-throttle.json')

  it('round-trips, and a missing or malformed file is an empty state', async () => {
    expect(await readThrottle(path)).toEqual({ state: empty, seal: null })
    await writeThrottle(path, { failures: [T0], lockedUntil: null }, null)
    expect((await readThrottle(path)).state).toEqual({ failures: [T0], lockedUntil: null })
    writeFileSync(path, '{"failures":"x"}')
    expect((await readThrottle(path)).state).toEqual(empty)
  })

  it('a seal made under K_prefs verifies; an edit or another key fails it (vault.preunlock.tampered)', async () => {
    const seal = sealThrottle(empty, k)
    await writeThrottle(path, empty, seal)
    const read = await readThrottle(path)
    expect(throttleSealIntact(read, k)).toBe(true)
    expect(throttleSealIntact(read, vaultNative().keyRandom())).toBe(false)
    await writeThrottle(path, { failures: [T0], lockedUntil: null }, seal)
    expect(throttleSealIntact(await readThrottle(path), k)).toBe(false)
  })

  it('a file without a seal is not tampered (failures recorded while locked have no key to seal with)', async () => {
    await writeThrottle(path, { failures: [T0], lockedUntil: null }, null)
    expect(throttleSealIntact(await readThrottle(path), k)).toBe(true)
  })
})

describe('throttled refusals are coalesced (review C10 low)', () => {
  const setup = () => {
    const clock = { mono: 5_000 }
    const out: { retryAt: number; refusals: number }[] = []
    const c = new RefusalCoalescer((f) => out.push(f), () => clock.mono)
    return { clock, out, c }
  }

  it('the first refusal of a lockout is logged at once, the rest once a minute with their count', () => {
    const { clock, out, c } = setup()
    c.refused(T0 + 180 * MIN)
    expect(out).toEqual([{ retryAt: T0 + 180 * MIN, refusals: 1 }])
    for (let i = 0; i < 50; i++) {
      clock.mono += 1_000
      c.refused(T0 + 180 * MIN)
    }
    // 50 refusals over 50 s: nothing more yet.
    expect(out).toHaveLength(1)
    clock.mono += 10_000
    c.refused(T0 + 180 * MIN)
    expect(out).toEqual([{ retryAt: T0 + 180 * MIN, refusals: 1 }, { retryAt: T0 + 180 * MIN, refusals: 51 }])
  })

  it('the end of a lockout flushes what was held back, and the next lockout logs at once again', () => {
    const { clock, out, c } = setup()
    c.refused(T0)
    clock.mono += 1_000
    c.refused(T0)
    c.refused(T0)
    c.ended()
    expect(out).toEqual([{ retryAt: T0, refusals: 1 }, { retryAt: T0, refusals: 2 }])
    c.ended()
    expect(out).toHaveLength(2)
    clock.mono += 1_000
    c.refused(T0 + MIN)
    expect(out).toHaveLength(3)
  })

  it('a new lockout (a later retryAt) is logged at once, after what the previous one held back (review C11 low)', () => {
    const { clock, out, c } = setup()
    c.refused(T0)
    clock.mono += 10_000
    c.refused(T0)
    clock.mono += 20_000
    // The previous lockout ended some other way (a recovery-key unlock) and three new failures started another.
    c.refused(T0 + 180 * MIN)
    expect(out).toEqual([
      { retryAt: T0, refusals: 1 },
      { retryAt: T0, refusals: 1 },
      { retryAt: T0 + 180 * MIN, refusals: 1 },
    ])
  })

  it('a retryAt that only jitters by the clock is the same lockout', () => {
    const { clock, out, c } = setup()
    c.refused(T0)
    clock.mono += 1_000
    c.refused(T0 + 3)
    expect(out).toHaveLength(1)
  })
})
