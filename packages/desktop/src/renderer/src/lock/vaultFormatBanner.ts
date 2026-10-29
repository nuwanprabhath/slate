import type { PqReadiness } from '../../../shared/api'

export const FORMAT_RUNNING = 'Updating the vault format in the background. You can keep working.'
export const FORMAT_DONE = 'Vault format updated. Your notes are unchanged, and your password and recovery key work as before.'

export interface FormatMemory {
  /** A version 2 vault was seen and its update has not been announced yet. */
  sawV2: boolean
}

/**
 * What the banner shows for the vault's current state. Main reports `done` for every version 3 vault, so "updated"
 * is announced only after this window (or an earlier one, via the stored memory) saw the vault at version 2.
 */
export function nextFormatBanner(memory: FormatMemory, vault: PqReadiness['vault']): { next: FormatMemory; show: 'running' | 'done' | null } {
  if (vault.kind !== 'header') return { next: memory, show: null }
  if (vault.version === 2) return { next: { sawV2: true }, show: vault.upgrade === 'running' ? 'running' : null }
  if (vault.version === 3 && vault.upgrade === 'done' && memory.sawV2) return { next: { sawV2: false }, show: 'done' }
  return { next: memory, show: null }
}
