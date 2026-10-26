import { describe, expect, it, vi } from 'vitest'
import { createSandboxMonitor, parseSeccomp, sandboxVerdict } from './rendererSandbox'

const STATUS = (seccomp: number) => `Name:\tslate\nUmask:\t0022\nNoNewPrivs:\t1\nSeccomp:\t${seccomp}\nSeccomp_filters:\t1\n`

describe('POAM-16: renderer sandbox detection', () => {
  it('reads the Seccomp mode from /proc/<pid>/status', () => {
    expect(parseSeccomp(STATUS(2))).toBe(2)
    expect(parseSeccomp(STATUS(0))).toBe(0)
    expect(parseSeccomp('Name:\tx\n')).toBeNull()
  })

  it('--no-sandbox means unsandboxed on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const)
      expect(sandboxVerdict({ platform, noSandboxSwitch: true, seccomp: [] })).toEqual({ sandboxed: false, reason: 'no-sandbox-switch' })
  })

  it('on Linux a renderer without seccomp-bpf (mode 2) is unsandboxed, whatever the switches say', () => {
    expect(sandboxVerdict({ platform: 'linux', noSandboxSwitch: false, seccomp: [2, 0] })).toEqual({ sandboxed: false, reason: 'seccomp-off' })
    expect(sandboxVerdict({ platform: 'linux', noSandboxSwitch: false, seccomp: [2, 2] })).toEqual({ sandboxed: true, reason: null })
  })

  it('an unreadable status is not evidence either way; macOS and Windows have no /proc', () => {
    expect(sandboxVerdict({ platform: 'linux', noSandboxSwitch: false, seccomp: [null] }).sandboxed).toBe(true)
    expect(sandboxVerdict({ platform: 'darwin', noSandboxSwitch: false, seccomp: [0] }).sandboxed).toBe(true)
  })

  it('the monitor probes every live renderer and logs the security event once', () => {
    const onUnsandboxed = vi.fn()
    const read = vi.fn((path: string) => (path === '/proc/7/status' ? STATUS(0) : STATUS(2)))
    const m = createSandboxMonitor({ platform: 'linux', hasNoSandboxSwitch: () => false, readStatus: read, rendererPids: () => [5, 7, 0], onUnsandboxed })
    expect(m.check()).toEqual({ sandboxed: false, reason: 'seccomp-off' })
    expect(m.check().sandboxed).toBe(false)
    expect(read).toHaveBeenCalledWith('/proc/5/status')
    expect(read).not.toHaveBeenCalledWith('/proc/0/status')
    expect(onUnsandboxed).toHaveBeenCalledTimes(1)
    expect(onUnsandboxed).toHaveBeenCalledWith('seccomp-off')
  })

  it('once unsandboxed, it stays so for the run (a renderer that later exits does not clear the notice)', () => {
    let pids = [7]
    const m = createSandboxMonitor({ platform: 'linux', hasNoSandboxSwitch: () => false, readStatus: () => STATUS(0), rendererPids: () => pids, onUnsandboxed: () => {} })
    expect(m.check().sandboxed).toBe(false)
    pids = []
    expect(m.check().sandboxed).toBe(false)
  })

  it('a read that throws counts as unreadable', () => {
    const m = createSandboxMonitor({
      platform: 'linux',
      hasNoSandboxSwitch: () => false,
      readStatus: () => {
        throw new Error('ENOENT')
      },
      rendererPids: () => [9],
      onUnsandboxed: () => {},
    })
    expect(m.check().sandboxed).toBe(true)
  })
})
