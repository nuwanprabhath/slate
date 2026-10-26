// "Copy diagnostic report" on the self-test error screen (audit S-6): the app version, the OS, the module's
// status and the failed checks with their times, redacted like a log line. It names no file and holds no key.
import type { NativeStatus } from '@slate/native'
import { redactString } from '../../../shared/redact'
import type { KatId } from './post'

export interface ReportInput {
  appVersion: string
  platform: string
  arch: string
  osRelease: string
  /** `native.status()` after the failure; null when the module never loaded. */
  module: NativeStatus | null
  failed: readonly KatId[]
  /** When the self-test failed (ISO 8601), and when this process started. */
  failedAt: string
  startedAt: string
  /** Whether the failure came at start-up or later (on demand, before a vault change, or a module call). */
  when: 'start-up' | 'later'
  /** The running user's home, rewritten to `~` wherever it appears. */
  home: string
}

/** Only the module status fields that describe the module; none is a path or key material. */
function moduleLines(s: NativeStatus | null): string[] {
  if (!s) return ['module: not loaded']
  return [
    `module: ${s.fipsModule ? `${s.fipsModule.name} ${s.fipsModule.version}` : 'no FIPS provider'}`,
    `libcrypto: ${s.libcrypto}`,
    `build: ${s.buildKind}`,
    `approved mode: ${String(s.fipsActive)}`,
    `error state: ${String(s.errorState)}`,
    `self-test passed: ${String(s.postPassed)}`,
    `module self-test failures: ${String(s.moduleSelfTestFailures)}`,
    `approved keys only: ${String(s.approvedKeysOnly)}`,
    `providers: ${s.defaultContextProviders}`,
    `secure heap locked: ${String(s.secureHeapLocked)}`,
    `live key handles: ${String(s.liveHandles)}`,
  ]
}

export function diagnosticReport(i: ReportInput): string {
  const text = [
    'Slate self-test report',
    `app: ${i.appVersion}`,
    `os: ${i.platform} ${i.arch} ${i.osRelease}`,
    `started: ${i.startedAt}`,
    `failed (${i.when}): ${i.failedAt}`,
    `failed checks: ${i.failed.join(', ') || 'none'}`,
    ...moduleLines(i.module),
  ].join('\n')
  return redactString(text, { home: i.home }) + '\n'
}
