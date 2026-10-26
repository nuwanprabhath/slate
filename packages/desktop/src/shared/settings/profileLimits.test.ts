import { describe, expect, it } from 'vitest'
import { allowedIdleOptions, profileLimits, shownIdleMinutes } from './schema'

const OPTIONS = [{ value: '5' }, { value: '15' }, { value: '30' }, { value: '60' }, { value: '0' }]

describe('profile limits on the Security settings', () => {
  it('T-POL-02: fips-140-3 shows "Never" and anything above 15 as 15, and offers neither', () => {
    const fips = profileLimits('fips-140-3')
    expect(shownIdleMinutes(0, fips)).toBe(15)
    expect(shownIdleMinutes(60, fips)).toBe(15)
    expect(shownIdleMinutes(5, fips)).toBe(5)
    expect(allowedIdleOptions(OPTIONS, fips).map((o) => o.value)).toEqual(['5', '15'])
  })

  it('T-POL-02: standard keeps every choice, "Never" included', () => {
    const std = profileLimits('standard')
    expect(shownIdleMinutes(0, std)).toBe(0)
    expect(allowedIdleOptions(OPTIONS, std)).toHaveLength(5)
    expect(profileLimits(null)).toEqual(std)
  })

  it('T-POL-03: fips-140-3 forces lock on sleep and on screen lock', () => {
    expect(profileLimits('fips-140-3')).toMatchObject({ lockOnSleepForced: true, lockOnScreenLockForced: true })
    expect(profileLimits('standard')).toMatchObject({ lockOnSleepForced: false, lockOnScreenLockForced: false })
  })
})
