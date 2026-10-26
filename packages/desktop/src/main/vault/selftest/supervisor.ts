// Wires the power-up self-test into start-up and fails closed later (audit §4.2 S-1 … S-9, §5.2; C6).
import { nativeErrorCode, type SlateNative } from '@slate/native'
import type { VaultState, VaultStateMachine } from '../vaultState'
import { isKatId, runPost, type KatId, type PostResult } from './post'

export interface SelfTestDeps {
  /** The module after load, hardening and init (native/cryptoModule.ts), or null when it could not be loaded. */
  native: SlateNative | null
  /** Why loading, hardening or init failed (`startCryptoModule`'s problem), or null when they passed. */
  startProblem: string | null
  /** S-4: install policy, the vault header's profile (unverified peek) or the profile floor says fips-140-3. */
  requireFips(): boolean
  vault: VaultStateMachine
  /** `initialVaultState()` over the data folder, evaluated only after the POST passed (S-1). */
  initialState(): VaultState | Promise<VaultState>
  corrupt: KatId | null
  /** The security events (log/securityEvents.ts `selftestPassed` / `selftestFailed`, phase `startup`). */
  passed(fields: { ran: number; ms: number; fips: boolean }): void
  failed(fields: { failed: readonly KatId[]; fips: boolean }): void
}

/** The KAT id a start-up problem stands for: `POST-MODULE-STATUS (SCC_15)` → `POST-MODULE-STATUS`. */
export function problemId(problem: string): KatId {
  const id = problem.split(' ')[0]
  return isKatId(id) ? id : 'POST-MODULE-LOAD'
}

/**
 * S-1 … S-6: runs before any IPC handler can reach a service, before a database is opened and before the data
 * folder decides the state. A failure leaves the vault in `selftest-failed` and the module in its error state.
 * Returns the result so index.ts can pick the first window: the lock screen, the notes or the error screen.
 */
export async function startupSelfTest(deps: SelfTestDeps): Promise<PostResult> {
  let result: PostResult
  if (deps.startProblem !== null && deps.native !== null) {
    try {
      deps.native.enterErrorState()
    } catch {
      // Already there.
    }
    result = { ok: false, failed: [problemId(deps.startProblem)], ran: [], ms: 0, module: null }
  } else {
    result = await runPost({ native: deps.native, requireFips: deps.requireFips(), corrupt: deps.corrupt, exclusive: true })
  }
  const fips = result.module?.fipsActive ?? false
  if (result.ok) {
    deps.vault.to(await deps.initialState())
    deps.passed({ ran: result.ran.length, ms: Math.round(result.ms), fips })
  } else {
    deps.vault.fail()
    deps.failed({ failed: result.failed, fips })
  }
  return result
}

export interface EmergencySteps {
  /** Destroy every window without asking it to flush, then show the self-test error window. */
  replaceWindowsWithErrorScreen(failed: readonly KatId[]): void
  /** Abort sync between files, stop MCP and the external watch; nothing waits on the renderer. */
  stopServices(): Promise<void>
  /** No update check runs after a failure, and the error screen's menu cannot start one (review C6). */
  stopUpdates(): void
  closeDatabases(): void
  closeKeyRing(): number | void
}

const failedClosed = new WeakSet<VaultStateMachine>()

/**
 * S-7/S-8: a self-test that fails after start-up (on demand, before a vault change, or a module call answering
 * SCC_12) moves every state to `selftest-failed`. The order matters: the state flips first so IPC refuses from
 * the next message, and the module zeroises (closing SQLCipher's connections) before anything slow runs. Every
 * step runs even if an earlier one throws; a second failure runs nothing again.
 */
export async function failClosed(native: Pick<SlateNative, 'enterErrorState'> | null, vault: VaultStateMachine, steps: EmergencySteps, failed: readonly KatId[]): Promise<void> {
  vault.fail()
  if (failedClosed.has(vault)) return
  failedClosed.add(vault)
  try {
    native?.enterErrorState()
  } catch {
    // Already in the error state.
  }
  const attempt = async (run: () => unknown) => {
    try {
      await run()
    } catch {
      // Every step runs: a broken sync must not keep a database open.
    }
  }
  await attempt(() => steps.replaceWindowsWithErrorScreen(failed))
  await attempt(() => steps.stopServices())
  await attempt(() => steps.stopUpdates())
  await attempt(() => steps.closeDatabases())
  await attempt(() => steps.closeKeyRing())
}

/**
 * S-7 (c): what a module error means. SCC_12 is the error state itself; a fault of the module (init, secure heap,
 * provider, handle table, DRBG, cipher, hardening, digest) calls for a self-test. Authentication (SCC_11) is a
 * normal result, and a refused argument, stale handle, oversized input or policy refusal (SCC_1, 8, 14, 16, 17)
 * is the caller's, not the module's, so neither runs one: the audit's "any code but SCC_11" would run a self-test
 * on every `destroyKey` of a handle already gone.
 */
export function moduleFault(e: unknown): 'error-state' | 'fault' | null {
  const code = nativeErrorCode(e)
  if (code === 'SCC_12') return 'error-state'
  if (code === null || ['SCC_1', 'SCC_8', 'SCC_11', 'SCC_14', 'SCC_16', 'SCC_17'].includes(code)) return null
  return 'fault'
}

type FaultKind = 'error-state' | 'fault'

/**
 * Review C6: where module faults go. Outside a self-test each is acted on at once; while one or more self-tests
 * run (counted, since on-demand and pre-change runs overlap) they are kept, the error state winning, and acted on
 * when the last run ends, unless that run failed (`ready` false: failClosed has already run). Nothing is acted
 * on before start-up handed over.
 */
export class FaultSupervisor {
  private running = 0
  private pending: FaultKind | null = null

  constructor(
    private readonly ready: () => boolean,
    private readonly act: (kind: FaultKind) => void,
  ) {}

  async during<T>(run: () => Promise<T>): Promise<T> {
    this.running++
    try {
      return await run()
    } finally {
      this.running--
      if (this.running === 0 && this.pending !== null) {
        const kind = this.pending
        this.pending = null
        if (this.ready()) this.act(kind)
      }
    }
  }

  report(kind: FaultKind): void {
    if (!this.ready()) return
    if (this.running > 0) {
      if (kind === 'error-state' || this.pending === null) this.pending = kind
      return
    }
    this.act(kind)
  }
}

/**
 * Review C6 (S-7 c): what a database error means. A module code is classified as any module call's; a plain
 * SQLite error counts only when the module has meanwhile entered its error state (a provider fault SQLCipher's
 * codec met first surfaces without an SCC code).
 */
export function databaseFault(e: unknown, native: Pick<SlateNative, 'status'> | null): 'error-state' | 'fault' | null {
  const kind = moduleFault(e)
  if (kind || nativeErrorCode(e) !== null) return kind
  try {
    return native?.status().errorState ? 'error-state' : null
  } catch {
    return 'error-state'
  }
}

/**
 * The module as the vault sees it: every call that throws (or rejects) with a module fault is reported to
 * `onFault` before the error reaches its caller, so SCC_12 anywhere (a sync download, an unlock, a lock)
 * escalates to failClosed (T-POST-08) instead of reading as "could not be verified" or a wrong password. So is
 * any `enterErrorState` call (the database's cipher check makes one).
 */
export function watchModule(native: SlateNative, onFault: (kind: 'error-state' | 'fault', e: unknown) => void): SlateNative {
  const report = (e: unknown) => {
    const kind = moduleFault(e)
    if (kind) onFault(kind, e)
  }
  // The addon's methods are read-only, non-configurable properties, which a proxy over the addon itself must
  // return unchanged; so the proxy stands over an empty object and forwards every read to the addon.
  return new Proxy({} as SlateNative, {
    get(_shell, prop) {
      const value: unknown = Reflect.get(native, prop)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        try {
          const out: unknown = Reflect.apply(value, native, args)
          // A caller that put the module in its error state itself (checkCipher, review C3) fails closed too.
          if (prop === 'enterErrorState') onFault('error-state', null)
          if (out instanceof Promise) {
            return out.catch((e: unknown) => {
              report(e)
              throw e
            })
          }
          return out
        } catch (e) {
          report(e)
          throw e
        }
      }
    },
  })
}
