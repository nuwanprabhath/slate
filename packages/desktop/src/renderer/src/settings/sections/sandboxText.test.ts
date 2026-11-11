import { describe, expect, it } from 'vitest'
import { lockSandboxNote, settingsSandboxNotice } from './sandboxText'

describe('POAM-16: the no-sandbox notice', () => {
  it('Settings shows it while unsandboxed and not dismissed', () => {
    const n = settingsSandboxNotice({ rendererUnsandboxed: true }, false)
    expect(n).not.toBeNull()
    expect(n?.title).toMatch(/without Chromium's sandbox/)
    expect(n?.body).toMatch(/other programs running as you can read/i)
    expect(n?.body).toMatch(/password/)
    expect(n?.body).toMatch(/\.deb/)
  })

  it('Settings hides it once dismissed, and when sandboxed', () => {
    expect(settingsSandboxNotice({ rendererUnsandboxed: true }, true)).toBeNull()
    expect(settingsSandboxNotice({ rendererUnsandboxed: false }, false)).toBeNull()
  })

  it('the lock screen shows a short line only while unsandboxed', () => {
    expect(lockSandboxNote({ rendererUnsandboxed: true, profile: 'standard' })).toMatch(/without Chromium's sandbox/)
    expect(lockSandboxNote({ rendererUnsandboxed: false, profile: 'standard' })).toBeNull()
    expect(lockSandboxNote({ rendererUnsandboxed: false, profile: 'fips-140-3' })).toBeNull()
  })

  // C5: a fips-140-3 vault will not unlock here at all, so the lock screen says so rather than warning.
  it('tells a fips-140-3 vault it will not unlock, and what to do', () => {
    const note = lockSandboxNote({ rendererUnsandboxed: true, profile: 'fips-140-3' })
    expect(note).toMatch(/will not unlock/)
    expect(note).toMatch(/FIPS 140-3/)
    expect(note).toMatch(/\.deb/)
  })
})
