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
    expect(lockSandboxNote({ rendererUnsandboxed: true })).toMatch(/without Chromium's sandbox/)
    expect(lockSandboxNote({ rendererUnsandboxed: false })).toBeNull()
  })
})
