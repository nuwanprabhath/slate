import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vaultNative } from './native'
import { PROFILES } from './profile'
import { readThrottle, ThrottleGate, throttleSealIntact, writeThrottle } from './unlockThrottle'

const fips = PROFILES['fips-140-3']
const std = PROFILES.standard
const MIN = 60_000
const T0 = 1_700_000_000_000

describe('ThrottleGate: the one owner of check and record (review C10)', () => {
  const k = vaultNative().keyRandom()
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-gate-'))
    const clock = { wall: T0, mono: 1_000 }
    const errors: unknown[] = []
    const path = join(dir, 'unlock-throttle.json')
    const gate = new ThrottleGate(path, { wall: () => clock.wall, mono: () => clock.mono }, (e) => errors.push(e))
    return { dir, path, clock, errors, gate }
  }
  const fail3 = async (g: ThrottleGate): Promise<void> => {
    for (let i = 0; i < 3; i++) await g.recordFailure(fips)
  }

  it('three guesses, not four: the failure is recorded before the next check can run', async () => {
    const { gate } = fresh()
    await gate.recordFailure(fips)
    await gate.recordFailure(fips)
    expect((await gate.check(fips)).allowed).toBe(true)
    await gate.recordFailure(fips)
    expect((await gate.check(fips)).allowed).toBe(false)
  })

  it('an unreasonable lockedUntil in the file is clamped to the policy duration from now', async () => {
    const { gate, path, clock } = fresh()
    await writeThrottle(path, { failures: [], lockedUntil: T0 + 10 * 365 * 24 * 60 * MIN }, null)
    expect((await gate.check(fips)).allowed).toBe(false)
    clock.wall = T0 + 180 * MIN + 1
    clock.mono += 180 * MIN + 1
    expect((await gate.check(fips)).allowed).toBe(true)
  })

  it('deleting the file does not end a lockout inside the session (in-memory floor)', async () => {
    const { gate, path } = fresh()
    await fail3(gate)
    rmSync(path)
    expect((await gate.check(fips)).allowed).toBe(false)
  })

  it('a failed write is reported and the lock still holds', async () => {
    const { dir, errors } = fresh()
    const bad = new ThrottleGate(join(dir, 'no-such-dir', 'x', 'unlock-throttle.json'), undefined, (e) => errors.push(e))
    await fail3(bad)
    expect(errors.length).toBeGreaterThan(0)
    expect((await bad.check(fips)).allowed).toBe(false)
  })

  it('moving the wall clock forward does not end a lockout within the session (monotonic source)', async () => {
    const { gate, clock } = fresh()
    await fail3(gate)
    clock.wall = T0 + 400 * MIN
    expect((await gate.check(fips)).allowed).toBe(false)
    clock.mono += 181 * MIN
    expect((await gate.check(fips)).allowed).toBe(true)
  })

  it('moving the wall clock back does not lengthen a lockout beyond the policy duration on the monotonic clock (review C10 low)', async () => {
    const { gate, clock } = fresh()
    await fail3(gate)
    clock.wall = T0 - 24 * 60 * MIN
    clock.mono += 10 * MIN
    const during = await gate.check(fips)
    expect(during).toEqual({ allowed: false, retryAt: clock.wall + 170 * MIN })
    clock.mono += 170 * MIN
    clock.wall += 170 * MIN
    expect((await gate.check(fips)).allowed).toBe(true)
  })

  it('a lock adopted from the file also ends on the monotonic clock when the wall clock goes back', async () => {
    const { gate, path, clock } = fresh()
    await writeThrottle(path, { failures: [], lockedUntil: T0 + 60 * MIN }, null)
    expect((await gate.check(fips)).allowed).toBe(false)
    clock.wall = T0 - 24 * 60 * MIN
    clock.mono += 60 * MIN
    expect((await gate.check(fips)).allowed).toBe(true)
  })

  it('success resets the memory and seals the file', async () => {
    const { gate, path } = fresh()
    await fail3(gate)
    expect((await gate.succeed(fips, k)).tampered).toBe(false)
    expect((await gate.check(fips)).allowed).toBe(true)
    expect(throttleSealIntact(await readThrottle(path), k)).toBe(true)
    expect((await readThrottle(path)).seal).not.toBeNull()
  })

  it('a standard vault is never throttled and never writes the file', async () => {
    const { gate, path } = fresh()
    for (let i = 0; i < 5; i++) await gate.recordFailure(std)
    expect((await gate.check(std)).allowed).toBe(true)
    await gate.succeed(std, k)
    expect(existsSync(path)).toBe(false)
  })
})
