import { log, securityLog, type LogFields, type LogScope, type ScopedLog } from './logger'

/**
 * The security audit events (audit §4.8, AU-2 / AU-3), each emitted by exactly one function here: the event's name
 * is a string literal in this file and nowhere else in the app (`tools/guards/securityEvents.test.ts`), so a
 * field list cannot drift between call sites and a secret cannot be added at one of them. Every field is plain
 * data (`LogFields` refuses bytes and key handles). None carries a key, a password, a note title or a path.
 *
 * Each event goes to the diagnostic log (when the user switched it on) and always to the security log
 * (`securityLog`, its own small rotating file), so a default install keeps the AU-2 record.
 *
 * Callers that already hold a `ScopedLog` (the update service, the launch code's injected `warn`) hand it as `to`.
 */
type Warn = Pick<ScopedLog, 'warn'>
type Info = Pick<ScopedLog, 'info'>
type Err = Pick<ScopedLog, 'error'>

/** A sink that writes to `to` (or the diagnostic log under `scope`) and to the security log. */
function mirror(scope: LogScope, to?: Partial<ScopedLog>): ScopedLog {
  const diag = log.scoped(scope)
  const one = (level: 'info' | 'warn' | 'error') => (message: string, fields?: LogFields): void => {
    ;(to?.[level] ?? diag[level])(message, fields)
    securityLog[level](scope, message, fields)
  }
  return { info: one('info'), warn: one('warn'), error: one('error') }
}

export type UnlockMethod = 'password' | 'recovery' | 'quick'
export type LockTrigger = 'idle' | 'sleep' | 'screen' | 'manual' | 'quit' | 'error'
export type SelftestPhase = 'startup' | 'on-demand' | 'pre-change' | 'module-error'
export type HeaderRefusal = 'downgrade' | 'profile' | 'schema' | 'check'

export const securityEvent = {
  selftestPassed: (f: { ran: number; ms: number; fips: boolean }, to?: Info): void => mirror('app', to).info('selftest.passed', f),
  selftestFailed: (f: { failed: readonly string[]; fips: boolean; phase: SelftestPhase }, to?: Err): void => mirror('app', to).error('selftest.failed', f),
  moduleDegraded: (f: { secureHeapLocked: false }, to?: Warn): void => mirror('app', to).warn('module.degraded', f),
  unlockSucceeded: (f: { method: UnlockMethod; headerRevision: number }, to?: Info): void => mirror('app', to).info('vault.unlock.succeeded', f),
  unlockFailed: (f: { method: UnlockMethod; failures: number }, to?: Warn): void => mirror('app', to).warn('vault.unlock.failed', f),
  /** `refusals`: how many attempts this record stands for (`RefusalCoalescer`). */
  unlockThrottled: (f: { retryAt: number; refusals: number }, to?: Warn): void => mirror('app', to).warn('vault.unlock.throttled', f),
  locked: (f: { trigger: LockTrigger; destroyedHandles: number }, to?: Info): void => mirror('app', to).info('vault.locked', f),
  headerAdopted: (f: { fromRevision: number; toRevision: number }, to?: Info): void => mirror('app', to).info('vault.header.adopted', f),
  headerRefused: (f: { reason: HeaderRefusal; headerVersion?: number; profile?: string; floorProfile?: string }, scope: 'app' | 'sync' = 'app'): void =>
    mirror(scope).warn('vault.header.refused', f),
  passwordChanged: (f: { revision: number }, to?: Info): void => mirror('app', to).info('vault.password.changed', f),
  recoveryRotated: (f: { revision: number }, to?: Info): void => mirror('app', to).info('vault.recovery.rotated', f),
  keyRotated: (f: { fromEpoch: number; toEpoch: number }, to?: Info): void => mirror('app', to).info('vault.key.rotated', f),
  keyRotationDue: (f: { dueSince: number }, to?: Warn): void => mirror('app', to).warn('vault.key.rotation-due', f),
  profileChanged: (f: { from: string; to: string }, to?: Info): void => mirror('app', to).info('vault.profile.changed', f),
  preunlockTampered: (to?: Warn): void => mirror('app', to).warn('vault.preunlock.tampered', {}),
  syncUnverifiable: (f: { count: number }, to?: Warn): void => mirror('sync', to).warn('sync.unverifiable', f),
  updateSignatureFailed: (f: { version: string | undefined }, to?: Err): void => mirror('update', to).error('update.signature.failed', f),
  /** `origin` is the sender's origin only (never its path or query). */
  ipcUntrustedSender: (f: { channel: string; origin: string }, to?: Warn): void => mirror('ipc', to).warn('ipc.untrusted-sender', f),
} as const

/** A frame URL as an origin for the log: no path, no query, nothing at all when it does not parse. */
export function originOf(url: unknown): string {
  if (typeof url !== 'string') return 'unknown'
  try {
    const u = new URL(url)
    return u.origin === 'null' ? `${u.protocol}//` : u.origin
  } catch {
    return 'invalid'
  }
}
