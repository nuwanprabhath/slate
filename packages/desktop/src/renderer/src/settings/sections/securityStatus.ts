import type { SyncState, VaultState } from '../../../../shared/api'

const LOCAL = 'Your notes are encrypted on this computer.'

/**
 * Claims the sync folder only when sync is on and a sync this session passed the vault check
 * (which runs before every upload and fails on a remote that is not this vault).
 */
export function securityStatusText(state: VaultState, sync: SyncState | null): string {
  if (state === 'migrating') return 'Encrypting your notes did not finish. Use the banner at the top of the window to finish or cancel it.'
  if (state !== 'unlocked') return 'Your notes are not encrypted.'
  if (!sync?.enabled) return LOCAL
  if (sync.vaultProblem === 'not-encrypted') return `${LOCAL} Your sync folder is not encrypted.`
  if (!sync.vaultProblem && sync.lastSyncedAt !== undefined) return 'Your notes are encrypted on this computer and in your sync folder.'
  return LOCAL
}
