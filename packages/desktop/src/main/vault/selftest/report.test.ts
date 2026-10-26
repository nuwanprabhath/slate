// Criterion 5 (audit §7.3 C6): the diagnostic report holds no path below $HOME and no key.
import type { NativeStatus } from '@slate/native'
import { describe, expect, it } from 'vitest'
import { diagnosticReport, type ReportInput } from './report'

const status: NativeStatus = {
  fipsActive: false,
  errorState: true,
  liveHandles: 0,
  secureHeapUsed: 0,
  secureHeapLocked: true,
  approvedKeysOnly: false,
  moduleSelfTestFailures: 0,
  postPassed: false,
  libcrypto: 'OpenSSL 3.5.9 30 Sep 2026',
  buildKind: 'slate-native-build:release',
  defaultContextProviders: 'base,fips',
  fipsModule: { name: 'OpenSSL FIPS Provider', version: '3.1.2' },
}

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  appVersion: '0.2.0',
  platform: 'darwin',
  arch: 'arm64',
  osRelease: '25.0.0',
  module: status,
  failed: ['POST-AES-GCM-ENC', 'POST-TIMEOUT'],
  failedAt: '2026-10-24T10:00:01.000Z',
  startedAt: '2026-10-24T10:00:00.000Z',
  when: 'start-up',
  home: '/Users/ann',
  ...over,
})

describe('the self-test diagnostic report (S-6, criterion 5)', () => {
  it('has the version, the OS, the module status and the failed checks with their times', () => {
    const r = diagnosticReport(input())
    for (const want of ['app: 0.2.0', 'os: darwin arm64 25.0.0', 'failed checks: POST-AES-GCM-ENC, POST-TIMEOUT', 'failed (start-up): 2026-10-24T10:00:01.000Z', 'started: 2026-10-24T10:00:00.000Z', 'OpenSSL FIPS Provider 3.1.2', 'error state: true', 'approved mode: false']) {
      expect(r).toContain(want)
    }
    expect(diagnosticReport(input({ module: null }))).toContain('module: not loaded')
  })

  it('names no path below $HOME and carries no key, even when a module string were to hold one', () => {
    const key = 'a1'.repeat(32)
    const b64 = Buffer.alloc(32, 7).toString('base64')
    const hostile = { ...status, libcrypto: `OpenSSL 3.5.9 /Users/ann/Library/x ${key}`, defaultContextProviders: `/home/bob/.config/y ${b64}` }
    const r = diagnosticReport(input({ module: hostile, osRelease: '/Users/ann/secret-dir' }))
    expect(r).not.toMatch(/\/Users\/|\/home\//)
    expect(r).not.toContain(key)
    expect(r).not.toContain(b64)
    expect(r).not.toContain('ann')
  })
})
