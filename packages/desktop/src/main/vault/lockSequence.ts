import type { VaultStateMachine } from './vaultState'

export interface LockSteps {
  /** Asks the window to write its pending edits; resolves when it says it has. */
  flushRenderer(): Promise<void>
  /** Opens and closes the note-write channels for the flush only (the state is already `locking`). */
  allowWrites?(on: boolean): void
  stopEvents(): void
  /** Stops the in-app MCP socket (§9) once a request it is serving has finished. */
  closeMcp?(): Promise<void>
  /** Resolves once a sync in progress has finished its current file. */
  stopSync(): Promise<void>
  closeWatch(): void
  closeDatabases(): void
  /** Drops main-process state the notes window could still name: the live OneNote backup pick (C2). */
  clearPicks?(): void
  closeKeys(): void
  /** Opens the lock window before the old one goes (§15 N6); right after the flush, so no slow step keeps notes on screen. */
  showLockWindow(): void
  clearClipboard(): void | Promise<void>
}

export const FLUSH_TIMEOUT_MS = 3000
const CLIPBOARD_WINDOW_MS = 2 * 60_000

/**
 * §6.4. Each step runs even if an earlier one failed: a broken sync must never leave the keys
 * open. The notes leave the screen as soon as the renderer has flushed; the keys close after
 * every user of them has stopped.
 */
export async function runLock(state: VaultStateMachine, steps: LockSteps, opts: { flushTimeoutMs?: number; onError?: (step: string, e: unknown) => void } = {}): Promise<void> {
  state.to('locking')
  const attempt = attempts(opts.onError)
  await boundedFlush(steps, attempt, opts.flushTimeoutMs)
  await attempt('window', () => steps.showLockWindow())
  await attempt('events', () => steps.stopEvents())
  await attempt('mcp', () => steps.closeMcp?.())
  await attempt('sync', () => steps.stopSync())
  await attempt('watch', () => steps.closeWatch())
  await attempt('databases', () => steps.closeDatabases())
  await attempt('picks', () => steps.clearPicks?.())
  await attempt('keys', () => steps.closeKeys())
  state.to('locked')
  await attempt('clipboard', () => steps.clearClipboard())
}

type Attempt = (name: string, run: () => unknown) => Promise<void>

/** Asks the windows to write what they hold, with the note-write channels open and a deadline on the answer. */
async function boundedFlush(steps: { flushRenderer(): Promise<void>; allowWrites?(on: boolean): void }, attempt: Attempt, timeoutMs?: number): Promise<void> {
  steps.allowWrites?.(true)
  await attempt('flush', () => Promise.race([steps.flushRenderer(), new Promise<void>((r) => setTimeout(r, timeoutMs ?? FLUSH_TIMEOUT_MS).unref?.())]))
  steps.allowWrites?.(false)
}

/** Each step runs even if an earlier one failed, and the caller hears which one broke. */
function attempts(onError?: (step: string, e: unknown) => void): Attempt {
  return async (name, run) => {
    try {
      await run()
    } catch (e) {
      onError?.(name, e)
    }
  }
}

export interface ShutdownSteps {
  /** Asks the window to write its pending edits; resolves when it says it has. */
  flushRenderer(): Promise<void>
  /** Opens and closes the note-write channels for the flush only. */
  allowWrites?(on: boolean): void
  stopEvents(): void
  /** Stops the in-app MCP socket (§9) once a request it is serving has finished. */
  closeMcp?(): Promise<void>
  /** Resolves once a sync in progress has finished its current file. */
  stopSync(): Promise<void>
  /** Closes everything that holds the notes, without waiting for a sync in flight. */
  closeServices(): void
}

/**
 * §6.4 at quit. The windows write what they still hold before anything holding the notes closes:
 * without that flush an append still queued in the renderer reached a closed store and was lost.
 */
export async function runShutdown(steps: ShutdownSteps, opts: { flushTimeoutMs?: number; onError?: (step: string, e: unknown) => void } = {}): Promise<void> {
  const attempt = attempts(opts.onError)
  await boundedFlush(steps, attempt, opts.flushTimeoutMs)
  await attempt('events', () => steps.stopEvents())
  await attempt('mcp', () => steps.closeMcp?.())
  await attempt('sync', () => steps.stopSync())
  await attempt('services', () => steps.closeServices())
}

/** What Slate last put on the clipboard: cleared at lock only if it is recent and still there. */
export function shouldClearClipboard(wrote: { at: number } | null, now: number): boolean {
  return wrote !== null && now - wrote.at <= CLIPBOARD_WINDOW_MS
}
