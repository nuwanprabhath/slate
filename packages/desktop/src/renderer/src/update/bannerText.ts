import type { UpdateState } from '../../../shared/api'

/** The sentence the banner shows for the current state. */
export function bannerText(state: UpdateState): string {
  const { phase, version, installError, progress } = state
  const v = `Slate ${version ?? ''}`.trim()
  if (installError && (phase === 'needs-password' || phase === 'downloaded' || phase === 'available')) return `Could not install ${v}: ${installError}`
  const percent = progress === undefined ? '' : ` ${progress}%`
  switch (phase) {
    case 'needs-password':
      return `${v} needs your password to install`
    case 'installing':
      return `Installing ${v}…`
    case 'downloading':
      return state.installRequested ? `Installing ${v}…${percent}` : `${v} is available · downloading ${progress ?? 0}%`
    case 'restarting':
      return `Restarting into ${v}…`
    case 'downloaded':
      return `${v} is downloaded${state.kind === 'dmg' ? ' · drag Slate into Applications' : ''}`
    default:
      return `${v} is available${state.currentVersion ? ` · you are on ${state.currentVersion}` : ''}`
  }
}
