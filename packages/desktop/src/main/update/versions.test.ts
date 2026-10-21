import { describe, expect, it } from 'vitest'
import { isNewer, parseVersion, releaseUrl } from './versions'

describe('parseVersion', () => {
  it('reads major.minor.patch with or without a leading v', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('v0.10.0')).toEqual([0, 10, 0])
  })

  it('is null for anything else', () => {
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
})

describe('isNewer', () => {
  it('compares numerically, not as strings', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
  })

  it('is false for the same or an older version, and for unreadable ones', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.0.9', '0.1.0')).toBe(false)
    expect(isNewer('garbage', '0.1.0')).toBe(false)
  })

  it('ranks a prerelease below its release', () => {
    expect(isNewer('1.0.0-beta.1', '0.9.0')).toBe(true)
    expect(isNewer('1.0.0-beta.1', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', '1.0.0-beta.1')).toBe(true)
  })
})

describe('releaseUrl', () => {
  it('points at the tag on GitHub', () => {
    expect(releaseUrl('0.2.0')).toBe('https://github.com/nuwanprabhath/slate/releases/tag/v0.2.0')
  })
})
