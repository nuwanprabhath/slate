import type { PqReadiness, PqWaiting, SyncProvider, TransportObservation } from '../../../../shared/api'

/** What Settings → Security → "Post-quantum readiness" says. No word here claims more than the state shows. */
export interface QuantumReadinessText {
  /** `help` is a muted line under the value. */
  rows: Array<{ id: 'at-rest' | 'vault' | 'signature'; label: string; value: string; help?: string }>
  /** One line per remote the connection was checked for; empty when it was not checked. `detail`: the key exchange and when it was seen. */
  transports: Array<{ remote: string; text: string; detail: string }>
  /** The existing format-upgrade action, offered for a version 1 vault. */
  vaultAction: string | null
  /** Shown only when sync is on and nothing is encrypted. */
  notice: { text: string; action: string } | null
}

export const CHECK_NOW = 'Check now'
export const UPGRADE_ACTION = 'Upgrade encryption format…'
export const ENCRYPT_ACTION = 'Encrypt my notes…'

const TO_UPDATE = 'to update to Slate 0.4 or newer'
/** Whatever the gate waits for, the device showing this runs a build that reads v3. */
const READY_HELP = 'This computer is ready. The format updates by itself once every device that syncs these notes runs Slate 0.4 or newer.'
const NAMED = 3

function waitingText(w: PqWaiting | undefined): string {
  if (w?.reason === 'sync-off') return 'Waiting for sync: turn it on so Slate can check your other devices'
  if (w?.reason === 'devices-unreadable') return 'Waiting: Slate could not read your device list. It tries again after the next sync.'
  const names = w?.devices ?? []
  if (names.length === 0) return `Waiting for your other devices ${TO_UPDATE}`
  if (names.length === 1) return `Waiting for "${names[0]!}" ${TO_UPDATE}`
  const quoted = names.slice(0, NAMED).map((n) => `"${n}"`).join(', ')
  const more = names.length > NAMED ? ` and ${String(names.length - NAMED)} more` : ''
  return `Waiting for ${String(names.length)} devices ${TO_UPDATE}: ${quoted}${more}`
}

function vaultText(v: PqReadiness['vault']): string {
  if (v.kind === 'none') return 'Not encrypted'
  if (v.version === 1) return 'Version 1, an older format'
  if (v.version === 3 || v.upgrade === 'done') return 'Current'
  if (v.upgrade === 'running') return 'Updating…'
  if (v.upgrade === 'waiting-devices') return waitingText(v.waiting)
  return 'Version 2'
}

/** When an observation was made: the time today, the date and time before today. */
export function checkedAtText(at: number, now: number, locale?: string): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date(now).toDateString()) return time
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return `${d.toLocaleDateString(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`
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

function transportDetail(o: TransportObservation, now: number, locale?: string): string {
  const checked = `checked ${checkedAtText(o.at, now, locale)}`
  return o.kex ? `${o.kex} · ${checked}` : checked
}

/** The host a git remote URL names (`git@host:path`, `ssh://…`, `https://…`); null for a folder on this computer. */
export function remoteHost(url: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]*)/i.exec(url)
  if (scheme) return scheme[1]!.toLowerCase() === 'file' || !scheme[2] ? null : scheme[2]
  const scp = /^(?:[^@/\\\s]+@)?([^:/\\\s]+):/.exec(url)
  // `C:\notes` is a Windows path, not a host.
  return scp && scp[1]!.length > 1 ? scp[1]! : null
}

/** What sync is set to, as `sync.status()` reports it; null until it answered. */
export interface SyncTarget {
  enabled: boolean
  provider: SyncProvider | null
  remote?: string
}

export type CheckState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; found: number } | { kind: 'error'; message: string }

function checkHost(sync: SyncTarget | null, transports: readonly TransportObservation[]): string | null {
  if (sync?.enabled && sync.provider === 'onedrive') return 'OneDrive'
  if (sync?.enabled && sync.provider === 'git' && sync.remote) return remoteHost(sync.remote)
  const first = transports[0]?.remote
  const i = first?.indexOf(':') ?? -1
  return first && i > 0 && REMOTE_KIND[first.slice(0, i)] ? first.slice(i + 1) : null
}

/** The line beside Check now: what it is doing, and what the last check found, even when that changed nothing. */
export function checkStatusText(check: CheckState, ctx: { sync: SyncTarget | null; transports: readonly TransportObservation[] }): string {
  switch (check.kind) {
    case 'idle':
      return ctx.transports.length === 0 ? 'Not checked yet' : ''
    case 'busy': {
      const host = checkHost(ctx.sync, ctx.transports)
      return host ? `Connecting to ${host}…` : 'Checking your sync connection…'
    }
    case 'error':
      return check.message
    case 'done': {
      if (check.found > 0) return 'Checked just now'
      const sync = ctx.sync
      if (!sync?.enabled || !sync.provider) return 'Nothing to check: sync is off'
      if (sync.provider === 'git' && sync.remote && remoteHost(sync.remote) === null) return 'Nothing to check: your sync folder is on this computer'
      const host = checkHost(sync, [])
      return `Nothing to check: Slate could not reach ${host ?? 'your sync remote'}`
    }
  }
}

export function quantumReadinessText(r: PqReadiness, now = Date.now(), locale?: string): QuantumReadinessText {
  return {
    rows: [
      { id: 'at-rest', label: 'Notes on this computer and in sync', value: 'AES-256: resistant to known quantum attacks' },
      { id: 'vault', label: 'Vault format', value: vaultText(r.vault), ...(r.vault.kind === 'header' && r.vault.upgrade === 'waiting-devices' && r.vault.version === 2 ? { help: READY_HELP } : {}) },
      { id: 'signature', label: 'Update signatures', value: r.updateSignature === 'ml-dsa-65+ed25519' ? 'ML-DSA-65 + Ed25519 (post-quantum)' : 'Ed25519' },
    ],
    transports: r.transports.map((o) => ({ remote: remoteLabel(o.remote), text: transportText(o), detail: transportDetail(o, now, locale) })),
    vaultAction: r.vault.kind === 'header' && r.vault.version === 1 ? UPGRADE_ACTION : null,
    notice: r.plaintextSync
      ? {
          text: 'Your notes sync unencrypted. Their protection in transit depends on the connection above, which may be recorded and decrypted later by a quantum computer.',
          action: ENCRYPT_ACTION,
        }
      : null,
  }
}
