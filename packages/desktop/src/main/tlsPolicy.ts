import tls from 'node:tls'
import { log, type ScopedLog } from './log/logger'

/** The hybrid group the default client offers first; the transport probe (PQ-C4) reports against it. */
export const HYBRID_TLS_GROUP = 'X25519MLKEM768'

/**
 * Main's one place that touches the TLS groups (INV-PQ-7, T-PQ-C3-03). `'auto'` is deliberate: under Electron's
 * BoringSSL it offers X25519MLKEM768 first and keeps secp384r1, which some servers (Microsoft) select, so no
 * explicit list is set. Anything else found here was set by someone else and is put back.
 */
export function applyTlsPolicy(to: Pick<ScopedLog, 'warn'> = log.scoped('app')): void {
  const found = tls.DEFAULT_ECDH_CURVE
  if (found === 'auto') return
  tls.DEFAULT_ECDH_CURVE = 'auto'
  to.warn('transport.tls.policy-changed', { from: found, to: 'auto' })
}
