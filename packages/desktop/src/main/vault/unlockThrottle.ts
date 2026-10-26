// AC-7 for the fips-140-3 profile (audit §4.1, B.15). A UI control only: someone holding a copy of the data
// folder is limited by the KDF cost alone, and a file edited while locked cannot be told from a fresh one.
import type { KeyHandle } from '@slate/native'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { canonicalJson } from './header'
import { equalBytes, toBase64, utf8, vaultNative } from './native'
import type { ProfilePolicy } from './profile'

export const THROTTLE_FILE = 'unlock-throttle.json'

export interface ThrottleState {
  /** Epoch ms of recent failed password attempts, oldest first. */
  failures: number[]
  lockedUntil: number | null
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAt: number }

/** The recovery key is the administrator release AC-7 asks for, so it is never throttled. */
export function canTryPassword(state: ThrottleState, policy: ProfilePolicy, now: number): ThrottleDecision {
  if (!policy.unlockThrottle) return { allowed: true }
  if (state.lockedUntil !== null && now < state.lockedUntil) return { allowed: false, retryAt: state.lockedUntil }
  return { allowed: true }
}

export function recordFailure(state: ThrottleState, policy: ProfilePolicy, now: number): ThrottleState {
  const t = policy.unlockThrottle
  if (!t) return state
  const windowStart = now - t.windowMinutes * 60_000
  const failures = [...state.failures.filter((at) => at >= windowStart), now]
  if (failures.length >= t.maxFailures) return { failures: [], lockedUntil: now + t.lockoutMinutes * 60_000 }
  return { failures, lockedUntil: state.lockedUntil }
}

export function recordSuccess(): ThrottleState {
  return { failures: [], lockedUntil: null }
}

/** The file: the state, and the MAC a successful unlock sealed it with (null for what was written while locked). */
export interface ThrottleFile {
  state: ThrottleState
  seal: string | null
}

const body = (s: ThrottleState): string => canonicalJson({ format: 'slate-unlock-throttle', version: 1, failures: s.failures, lockedUntil: s.lockedUntil })

/** HMAC-SHA-256 under K_prefs (a handle: the key never leaves the module). */
export function sealThrottle(state: ThrottleState, kPrefs: KeyHandle): string {
  return toBase64(vaultNative().hmacSha256(kPrefs, utf8(body(state))))
}

/**
 * After an unlock: a seal that is present must verify. Only the empty state is ever sealed (at an unlock), and
 * failures recorded while locked carry no seal (there was no key). So this detects one thing: a sealed file
 * edited to something stricter. It cannot tell a deleted or rolled-back file from a fresh one.
 */
export function throttleSealIntact(file: ThrottleFile, kPrefs: KeyHandle): boolean {
  if (file.seal === null) return true
  return equalBytes(Buffer.from(file.seal, 'base64'), Buffer.from(sealThrottle(file.state, kPrefs), 'base64'))
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** A missing, oversized or malformed file is an empty state: this is a UI control, not a gate. */
export async function readThrottle(path: string): Promise<ThrottleFile> {
  const none: ThrottleFile = { state: recordSuccess(), seal: null }
  let json: unknown
  try {
    json = await readJsonCapped(path)
  } catch {
    return none
  }
  if (typeof json !== 'object' || json === null) return none
  const j = json as Record<string, unknown>
  if (!Array.isArray(j.failures) || j.failures.length > 100 || !j.failures.every(isTime)) return none
  if (j.lockedUntil !== null && !isTime(j.lockedUntil)) return none
  return { state: { failures: j.failures as number[], lockedUntil: j.lockedUntil as number | null }, seal: typeof j.seal === 'string' ? j.seal : null }
}

export async function writeThrottle(path: string, state: ThrottleState, seal: string | null): Promise<void> {
  await writeJsonAtomic(path, { format: 'slate-unlock-throttle', version: 1, failures: state.failures, lockedUntil: state.lockedUntil, seal })
}

export interface ThrottleClock {
  /** Epoch ms; a user can move it. */
  wall(): number
  /** Monotonic ms within this process; nothing moves it. */
  mono(): number
}
const SYSTEM_CLOCK: ThrottleClock = { wall: () => Date.now(), mono: () => performance.now() }

/**
 * The one owner of AC-7 for a data folder: it checks and records, so an attempt can never read state a previous
 * failure has not written yet. What a process has seen is kept in memory too: deleting or rolling back the file
 * (or a failed write) cannot end a lockout during the session, a `lockedUntil` beyond the policy's duration from now
 * is clamped, and a lock this process started also holds against a moved wall clock. Across restarts it is still a
 * user-interface control, and the file is what carries it.
 */
export class ThrottleGate {
  private memory: ThrottleState = recordSuccess()
  private monoLockedUntil = 0

  constructor(
    private readonly path: string,
    private readonly clock: ThrottleClock = SYSTEM_CLOCK,
    private readonly onWriteError: (e: unknown) => void = () => {},
  ) {}

  private adoptedFile = false

  /**
   * The file's state merged with what this process knows. A lock found in the file is adopted once, clamped to the
   * policy's duration from now (a planted or mistaken `lockedUntil` cannot last years), and from then on memory owns it.
   */
  private async merged(policy: ProfilePolicy): Promise<ThrottleState> {
    const file = (await readThrottle(this.path)).state
    const t = policy.unlockThrottle
    if (!this.adoptedFile) {
      this.adoptedFile = true
      if (file.lockedUntil !== null && t) {
        const now = this.clock.wall()
        const until = Math.min(file.lockedUntil, now + t.lockoutMinutes * 60_000)
        this.memory = { ...this.memory, lockedUntil: until }
        this.monoLockedUntil = Math.max(this.monoLockedUntil, this.clock.mono() + Math.max(0, until - now))
      }
    }
    const failures = file.failures.length >= this.memory.failures.length ? file.failures : this.memory.failures
    return { failures, lockedUntil: this.memory.lockedUntil }
  }

  async check(policy: ProfilePolicy): Promise<ThrottleDecision> {
    if (!policy.unlockThrottle) return { allowed: true }
    const merged = await this.merged(policy)
    const now = this.clock.wall()
    // A lock this process started or adopted runs on the monotonic clock alone: moving the wall clock either way
    // can neither end it early nor stretch it past the policy's duration.
    if (merged.lockedUntil !== null && this.monoLockedUntil > 0) {
      const left = this.monoLockedUntil - this.clock.mono()
      if (left > 0) return { allowed: false, retryAt: now + left }
      this.memory = { ...this.memory, lockedUntil: null }
      this.monoLockedUntil = 0
      return { allowed: true }
    }
    return canTryPassword(merged, policy, now)
  }

  /** Awaited before the vault returns to `locked`, so the next attempt sees it. */
  async recordFailure(policy: ProfilePolicy): Promise<void> {
    const t = policy.unlockThrottle
    if (!t) return
    const before = await this.merged(policy)
    const next = recordFailure(before, policy, this.clock.wall())
    if (next.lockedUntil !== null && next.lockedUntil !== before.lockedUntil) this.monoLockedUntil = this.clock.mono() + t.lockoutMinutes * 60_000
    this.memory = next
    try {
      await writeThrottle(this.path, next, null)
    } catch (e) {
      this.onWriteError(e)
    }
  }

  /** A successful unlock (any method): checks the seal, then resets memory and file, sealed under K_prefs. */
  async succeed(policy: ProfilePolicy, kPrefs: KeyHandle): Promise<{ tampered: boolean }> {
    this.memory = recordSuccess()
    this.monoLockedUntil = 0
    if (!policy.unlockThrottle) return { tampered: false }
    try {
      const tampered = !throttleSealIntact(await readThrottle(this.path), kPrefs)
      await writeThrottle(this.path, recordSuccess(), sealThrottle(recordSuccess(), kPrefs))
      return { tampered }
    } catch (e) {
      this.onWriteError(e)
      return { tampered: false }
    }
  }
}

/** At most one `vault.unlock.throttled` record a minute while a lockout lasts. */
export const REFUSAL_LOG_INTERVAL_MS = 60_000
const NEW_LOCKOUT_MS = 60_000

/**
 * Coalesces throttled refusals for the security log: the first refusal of a lockout is recorded at once, later ones
 * at most once a minute with how many there were, and the end of the lockout records any held back. A script
 * hammering the lock screen therefore cannot fill the security log and rotate the earlier records out.
 */
export class RefusalCoalescer {
  private held = 0
  private lastRetryAt = 0
  private lastEmit: number | null = null

  constructor(
    private readonly emit: (f: { retryAt: number; refusals: number }) => void,
    private readonly mono: () => number = () => performance.now(),
  ) {}

  refused(retryAt: number): void {
    // A later retryAt than this burst's is a new lockout (a lockout is hours; the clocks only jitter it by
    // milliseconds): what the old one held back goes out first, and the new one's first refusal is not held.
    if (this.lastEmit !== null && retryAt > this.lastRetryAt + NEW_LOCKOUT_MS) this.ended()
    this.held++
    this.lastRetryAt = retryAt
    const now = this.mono()
    if (this.lastEmit !== null && now - this.lastEmit < REFUSAL_LOG_INTERVAL_MS) return
    this.flush(now)
  }

  /** The lockout is over: a password attempt was allowed, any unlock succeeded, or the app quits. */
  ended(): void {
    if (this.held > 0) this.flush(this.mono())
    this.lastEmit = null
  }

  private flush(now: number): void {
    this.emit({ retryAt: this.lastRetryAt, refusals: this.held })
    this.held = 0
    this.lastEmit = now
  }
}
