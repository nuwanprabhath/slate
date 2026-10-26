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
  const attempt = async (name: string, run: () => unknown) => {
    try {
      await run()
    } catch (e) {
      opts.onError?.(name, e)
    }
  }
  steps.allowWrites?.(true)
  await attempt('flush', () =>
    Promise.race([steps.flushRenderer(), new Promise<void>((r) => setTimeout(r, opts.flushTimeoutMs ?? FLUSH_TIMEOUT_MS).unref?.())]),
  )
  steps.allowWrites?.(false)
  await attempt('window', () => steps.showLockWindow())
  await attempt('events', () => steps.stopEvents())
  await attempt('mcp', () => steps.closeMcp?.())
  await attempt('sync', () => steps.stopSync())
  await attempt('watch', () => steps.closeWatch())
  await attempt('databases', () => steps.closeDatabases())
  await attempt('keys', () => steps.closeKeys())
  state.to('locked')
  await attempt('clipboard', () => steps.clearClipboard())
}

/** What Slate last put on the clipboard: cleared at lock only if it is recent and still there. */
export function shouldClearClipboard(wrote: { at: number; text: string } | null, current: string, now: number): boolean {
  return wrote !== null && now - wrote.at <= CLIPBOARD_WINDOW_MS && current === wrote.text
}
