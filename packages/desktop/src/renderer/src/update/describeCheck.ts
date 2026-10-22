import type { UpdateState } from '../../../shared/api'

/**
 * What a check the user pressed for found. Read from the state `update.check()` resolves with, not
 * from a pushed event: the push may have landed before the button started listening.
 */
export function describeCheck(state: UpdateState): string {
  if (state.phase === 'error') return `Could not check: ${state.error ?? 'unknown error'}`
  if (state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded') {
    const skipped = state.skippedVersion === state.version ? ' (skipped)' : ''
    return `Slate ${state.version} is available${skipped}.`
  }
  return "You're up to date."
}

export function formatChecked(at: number | undefined): string {
  return at === undefined ? 'never' : new Date(at).toLocaleString()
}
