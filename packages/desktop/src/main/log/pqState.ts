// What the diagnostic log says about the post-quantum state (PQ-D3): the vault header version and the last key
// exchange seen for each remote, host level only. Written to the log (which redacts every field on the way in)
// when the log is read or copied, so a bug report carries it.
import type { TransportObservation } from '../../shared/api'
import type { LogFields, ScopedLog } from './logger'

export interface PqDiagnostics {
  transports: readonly TransportObservation[]
  /** Null while no vault exists (plaintext notes) or it cannot be read. */
  vaultHeaderVersion: 1 | 2 | 3 | null
}

/** `git-ssh:github.com`, `git-https:host:8443`: a scheme and a host, never a user, path, query or token. */
const HOST_ONLY = /^[a-z][a-z0-9-]*:[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/

export function pqDiagnosticFields(d: PqDiagnostics): LogFields {
  return {
    vaultHeaderVersion: d.vaultHeaderVersion,
    transports: d.transports.map((t) => ({
      remote: HOST_ONLY.test(t.remote) ? t.remote : '[not a host]',
      transport: t.transport,
      kex: t.kex,
      pq: t.pq,
      at: t.at,
    })),
  }
}

export function logPqState(log: Pick<ScopedLog, 'info'>, d: PqDiagnostics): void {
  log.info('post-quantum state', pqDiagnosticFields(d))
}
