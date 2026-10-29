import type { PqReadiness, TransportObservation } from '../../../../shared/api'

/** What Settings → Security → "Post-quantum readiness" says. No word here claims more than the state shows. */
export interface QuantumReadinessText {
  rows: Array<{ id: 'at-rest' | 'vault' | 'signature'; label: string; value: string }>
  /** One line per remote the connection was checked for; empty when it was not checked. */
  transports: Array<{ remote: string; text: string }>
  /** The existing format-upgrade action, offered for a version 1 vault. */
  vaultAction: string | null
  /** Shown only when sync is on and nothing is encrypted. */
  notice: { text: string; action: string } | null
}

export const CHECK_NOW = 'Check now'
export const UPGRADE_ACTION = 'Upgrade encryption format…'
export const ENCRYPT_ACTION = 'Encrypt my notes…'

function vaultText(v: PqReadiness['vault']): string {
  if (v.kind === 'none') return 'Not encrypted'
  if (v.version === 1) return 'Version 1, an older format'
  if (v.version === 3 || v.upgrade === 'done') return 'Current'
  if (v.upgrade === 'running') return 'Updating…'
  if (v.upgrade === 'waiting-devices') {
    const n = v.blockingDevices.length
    return `Waiting for ${String(n)} ${n === 1 ? 'device' : 'devices'} to update to Slate 0.4 or newer`
  }
  return 'Version 2'
}

const REMOTE_KIND: Readonly<Record<string, string>> = { 'git-ssh': 'git over SSH', 'git-https': 'git over HTTPS', onedrive: 'OneDrive' }

/** A stored remote is `scheme:host[:port]` (git-ssh:github.com); say it the way a person would. */
export function remoteLabel(remote: string): string {
  const i = remote.indexOf(':')
  const kind = i > 0 ? REMOTE_KIND[remote.slice(0, i)] : undefined
  if (!kind) return remote
  const host = remote.slice(i + 1)
  return kind === 'OneDrive' ? `${host} (OneDrive)` : `${host} (${kind})`
}

function transportText(o: TransportObservation): string {
  if (o.pq === 'hybrid') return 'Post-quantum key exchange (ML-KEM)'
  // A connection that negotiated something names it; one with no name never got that far on this computer.
  if (o.pq === 'classical') return o.kex === null ? "Classical key exchange: this computer's ssh/git cannot do post-quantum" : 'Classical key exchange: the server does not offer post-quantum'
  return 'Not checked'
}

export function quantumReadinessText(r: PqReadiness): QuantumReadinessText {
  return {
    rows: [
      { id: 'at-rest', label: 'Notes on this computer and in sync', value: 'AES-256: resistant to known quantum attacks' },
      { id: 'vault', label: 'Vault format', value: vaultText(r.vault) },
      { id: 'signature', label: 'Update signatures', value: r.updateSignature === 'ml-dsa-65+ed25519' ? 'ML-DSA-65 + Ed25519 (post-quantum)' : 'Ed25519' },
    ],
    transports: r.transports.map((o) => ({ remote: remoteLabel(o.remote), text: transportText(o) })),
    vaultAction: r.vault.kind === 'header' && r.vault.version === 1 ? UPGRADE_ACTION : null,
    notice: r.plaintextSync
      ? {
          text: 'Your notes sync unencrypted. Their protection in transit depends on the connection above, which may be recorded and decrypted later by a quantum computer.',
          action: ENCRYPT_ACTION,
        }
      : null,
  }
}
