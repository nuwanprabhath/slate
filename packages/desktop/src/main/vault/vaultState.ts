import type { VaultState } from '../../shared/api'

export type { VaultState }

/** Shown on the lock screen when the vault exists but this computer's key file does not. */
export const KEY_FILE_MISSING_MESSAGE =
  "This computer's key file (local-keys.json) is missing, so the encrypted notes here cannot be opened. If your notes sync, move Slate's data folder aside and join the sync folder again with your password or recovery key."

/**
 * §15 N10: a vault header without local keys, with `migration.json` and the plaintext database
 * still there, is a migration that never finished. Without both it is a lost key file: locked, so
 * a fresh plaintext database is never opened over an encrypted folder.
 */
export function initialVaultState(files: { vault: boolean; localKeys: boolean; migration: boolean; plainDb: boolean }): VaultState {
  if (!files.vault) return 'plaintext'
  if (files.localKeys) return 'locked'
  return files.migration && files.plainDb ? 'migrating' : 'locked'
}

/** Whether note services exist and note IPC may run. Never during or after the power-up self-test's failure. */
export function notesOpen(state: VaultState): boolean {
  return state === 'unlocked' || state === 'plaintext' || state === 'migrating'
}

/**
 * `selftest` is the only start state (audit §4.2 S-1): the power-up self-test hands over to `plaintext`,
 * `locked` or `migrating` once every check passed. `selftest-failed` has no way out (S-9): the process must
 * exit, and the next launch runs the self-test again. Every other state may fall into it when an on-demand
 * or conditional self-test fails, or the module answers SCC_12 (S-7).
 */
const MOVES: Record<VaultState, readonly VaultState[]> = {
  selftest: ['plaintext', 'locked', 'migrating', 'selftest-failed'],
  'selftest-failed': [],
  // "Encrypt my notes" or joining an encrypted remote (§7.1, §7.3).
  plaintext: ['migrating', 'selftest-failed'],
  // Cancelling an unfinished migration leaves a plain data folder; finishing it opens the vault.
  migrating: ['plaintext', 'unlocked', 'selftest-failed'],
  locked: ['unlocking', 'selftest-failed'],
  unlocking: ['unlocked', 'locked', 'selftest-failed'],
  unlocked: ['locking', 'selftest-failed'],
  locking: ['locked', 'selftest-failed'],
}

export class VaultStateMachine {
  private listeners = new Set<(state: VaultState) => void>()
  private current: VaultState = 'selftest'

  get state(): VaultState {
    return this.current
  }

  to(next: VaultState): void {
    if (!MOVES[this.current].includes(next)) throw new Error(`Vault state cannot go ${this.current} → ${next}`)
    this.current = next
    this.listeners.forEach((l) => l(next))
  }

  /** Into the terminal `selftest-failed`, from any state. Idempotent: failing again while failed is not an error. */
  fail(): void {
    if (this.current !== 'selftest-failed') this.to('selftest-failed')
  }

  onChange(listener: (state: VaultState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
