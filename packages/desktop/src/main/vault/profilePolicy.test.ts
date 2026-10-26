import { describe, expect, it } from 'vitest'
import { profileLimits } from '../../shared/settings/schema'
import { effectiveIdleMinutes, locksOnScreenLock, locksOnSleep, PROFILES } from './profile'

const fips = PROFILES['fips-140-3']
const std = PROFILES.standard

describe('profile policy: idle lock and lock triggers', () => {
  it('T-POL-02: effectiveIdleMinutes(0, fips) and (60, fips) are 15; standard is the stored value', () => {
    expect(effectiveIdleMinutes(0, fips)).toBe(15)
    expect(effectiveIdleMinutes(60, fips)).toBe(15)
    expect(effectiveIdleMinutes(5, fips)).toBe(5)
    expect(effectiveIdleMinutes(0, std)).toBe(0)
    expect(effectiveIdleMinutes(240, std)).toBe(240)
  })

  it('T-POL-02: the Settings UI limits are the policy main enforces', () => {
    const ui = profileLimits('fips-140-3')
    expect(ui.maxIdleMinutes).toBe(fips.maxIdleMinutes)
    expect(ui.lockOnSleepForced).toBe(fips.forceLockOnSleep)
    expect(ui.lockOnScreenLockForced).toBe(fips.forceLockOnScreenLock)
    expect(profileLimits('standard')).toEqual({ maxIdleMinutes: std.maxIdleMinutes, lockOnSleepForced: std.forceLockOnSleep, lockOnScreenLockForced: std.forceLockOnScreenLock })
  })

  it('T-POL-03: fips-140-3 locks on sleep and on screen lock whatever the stored setting says', () => {
    expect(locksOnSleep(fips, false)).toBe(true)
    expect(locksOnScreenLock(fips, false)).toBe(true)
  })

  it('T-POL-03: standard follows the setting (on unless switched off)', () => {
    expect(locksOnSleep(std, false)).toBe(false)
    expect(locksOnSleep(std, undefined)).toBe(true)
    expect(locksOnScreenLock(std, false)).toBe(false)
    expect(locksOnScreenLock(std, true)).toBe(true)
  })
})
