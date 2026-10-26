import { describe, expect, it } from 'vitest'
import { MIN_FREE_GB, lowDiskMessage, parseDfFreeKb, parseFreeBytesAsKb } from '../e2e-ubuntu/diskGuard'

// The cross-device harness (e2e-ubuntu) builds a ~4 GB image and caches a v0.1.0 build; it must refuse
// before it can fill the Mac's disk.
describe('e2e-ubuntu disk guard', () => {
  it('reads the Available column of df -k', () => {
    const out = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 239362496 13631488 15728640 48% /\n'
    expect(parseDfFreeKb(out)).toBe(15728640)
    expect(parseDfFreeKb('garbage')).toBeUndefined()
  })

  it('reads the byte count the Finder-style query prints', () => {
    expect(parseFreeBytesAsKb('1048576\n')).toBe(1024)
    expect(parseFreeBytesAsKb('')).toBeUndefined()
    expect(parseFreeBytesAsKb('-3')).toBeUndefined()
  })

  it('refuses below the floor and allows at or above it', () => {
    expect(MIN_FREE_GB).toBe(8)
    expect(lowDiskMessage(7.9 * 1024 * 1024)).toMatch(/Refusing.*7\.9 GiB free.*at least 8 GiB/)
    expect(lowDiskMessage(8 * 1024 * 1024)).toBeUndefined()
  })
})
