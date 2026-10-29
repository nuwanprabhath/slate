import type { SyncProvider, TransportObservation } from '../../../shared/api'
import { remoteLabel } from '../settings/sections/quantumReadinessText'

export const REQUIRE_PQ_LABEL = 'Require post-quantum key exchange'
export const REQUIRE_PQ_HELP = 'Sync stops with an error instead of falling back to a classical connection.'
export const REQUIRE_PQ_CHECKING = 'Checking the connection…'
export const REQUIRE_PQ_CHECK_FAILED = 'Could not check the connection. Sync will stop with an error if the server does not offer post-quantum key exchange.'

/** The refusals main gives under this setting (`PQ_REFUSAL` in main/sync/syncService.ts), shown before it is turned on. */
const REASON = {
  onedrive: 'Microsoft OneDrive does not offer post-quantum key exchange yet',
  https: 'Use an SSH remote for post-quantum key exchange',
  noSsh: 'Enter an SSH repository URL to use this',
} as const

/** null: nothing to offer (sync is off). Otherwise whether the box can be turned on, and why not. */
export function requirePqAvailability(provider: SyncProvider | null, remoteUrl: string): { enabled: true } | { enabled: false; reason: string } | null {
  if (provider === null) return null
  if (provider === 'onedrive') return { enabled: false, reason: REASON.onedrive }
  const url = remoteUrl.trim()
  if (/^https?:\/\//i.test(url)) return { enabled: false, reason: REASON.https }
  // scp-like (git@host:path) or ssh://, the two spellings git over SSH has; a local path is neither.
  if (/^ssh:\/\//i.test(url) || /^(?:[^/@:\s]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:(?!\/\/)(?![\\/])/.test(url)) return { enabled: true }
  return { enabled: false, reason: REASON.noSsh }
}

/** After the check: what to tell a person whose git SSH remote negotiated a classical key exchange; null when nothing is wrong. */
export function classicalWarning(observations: readonly TransportObservation[]): string | null {
  const bad = observations.filter((o) => o.remote.startsWith('git-ssh:') && o.pq === 'classical')
  if (bad.length === 0) return null
  const names = bad.map((o) => remoteLabel(o.remote)).join(', ')
  return `The last check of ${names} found a classical key exchange. With this on, sync will stop with an error until the server or this computer supports post-quantum key exchange.`
}
