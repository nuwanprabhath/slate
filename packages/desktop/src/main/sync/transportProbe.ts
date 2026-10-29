import tls from 'node:tls'
import { classifyKex, PqTransportUnavailable, remoteTransport, sshCommand, type SshKexProbe } from '@slate/sync'
import type { GitSettings, SyncProvider, TransportObservation, VaultState } from '../../shared/api'
import type { GitConnectionCheck } from './git/auth'

/** Graph serves the files, login.microsoftonline.com the tokens: both carry OneDrive sync. */
export const ONEDRIVE_HOSTS = ['graph.microsoft.com', 'login.microsoftonline.com'] as const

const TLS_PROBE_TIMEOUT_MS = 10_000

export interface TlsProbeOptions {
  /** Tests only: the loopback fixture's CA and name. The app always verifies against the system store. */
  ca?: string | Buffer
  servername?: string
  timeoutMs?: number
}

/**
 * The TLS group a default client negotiates with `host`: a bare handshake, read with `getEphemeralKeyInfo()`,
 * then closed. No HTTP byte is written and no token is involved. Null when the handshake failed.
 */
export function tlsGroup(host: string, port = 443, opts: TlsProbeOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (group: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(group)
    }
    const socket = tls.connect({ host, port, ...(opts.servername ? { servername: opts.servername } : {}), ...(opts.ca ? { ca: opts.ca } : {}) }, () => {
      const info = socket.getEphemeralKeyInfo()
      finish(info !== null && 'name' in info && typeof info.name === 'string' ? info.name : null)
    })
    socket.on('error', () => finish(null))
    const timer = setTimeout(() => finish(null), opts.timeoutMs ?? TLS_PROBE_TIMEOUT_MS)
  })
}

export interface ProbeInput {
  /** Probing reaches the network from the notes' settings, so it runs only while they are open. */
  state: VaultState
  settings: { syncProvider: SyncProvider | null; git?: GitSettings | null; syncRequirePq: boolean }
  /** OneDrive is probed only when this is https (a test drive on loopback is not Microsoft's). */
  graphUrl: string
  /** `testConnection` over the configured remote with this GIT_SSH_COMMAND (undefined: not ssh). */
  git: (url: string, sshCommand: string | undefined) => Promise<GitConnectionCheck>
  ssh: () => Promise<SshKexProbe>
  tls?: (host: string, port: number) => Promise<string | null>
  record: (o: TransportObservation) => void
  now?: () => number
}

export class ProbeRefused extends Error {
  override readonly name = 'ProbeRefused'
}

/**
 * Observes the key exchange of every transport the sync settings use and records it with `source: 'probe'`.
 * Under `syncRequirePq` an https git remote is not contacted at all (its credentials would cross a classical
 * channel); the OneDrive handshake sends nothing, so it still runs.
 */
export async function probeTransports(input: ProbeInput): Promise<TransportObservation[]> {
  if (input.state !== 'unlocked' && input.state !== 'plaintext') throw new ProbeRefused('The transport probe runs only while the notes are open')
  const at = (input.now ?? Date.now)()
  const seen: TransportObservation[] = []
  const { syncProvider, git, syncRequirePq } = input.settings
  if (syncProvider === 'onedrive' && new URL(input.graphUrl).protocol === 'https:') {
    const connect = input.tls ?? ((host: string, port: number) => tlsGroup(host, port))
    for (const host of ONEDRIVE_HOSTS) {
      const kex = await connect(host, 443)
      seen.push({ remote: `onedrive:${host}`, transport: 'tls', kex, pq: classifyKex(kex), source: 'probe', at })
    }
  }
  if (syncProvider === 'git' && git?.remoteUrl) {
    const transport = remoteTransport(git.remoteUrl)
    if (transport?.kind === 'ssh') {
      let command: string | undefined
      try {
        command = sshCommand(await input.ssh(), syncRequirePq ? 'require' : 'prefer')
      } catch (e) {
        // 'require' with an ssh that has no hybrid: sync refuses this remote too, so it is not contacted.
        if (!(e instanceof PqTransportUnavailable)) throw e
      }
      if (command !== undefined) seen.push(...observed(await input.git(git.remoteUrl, command), 'ssh', at))
    } else if (transport?.kind === 'https' && !syncRequirePq) {
      seen.push(...observed(await input.git(git.remoteUrl, undefined), 'tls', at))
    }
  }
  for (const o of seen) input.record(o)
  return seen
}

/** What testConnection saw, or nothing when git never ran (no remote id to file it under). */
function observed(check: GitConnectionCheck, transport: TransportObservation['transport'], at: number): TransportObservation[] {
  if (check.remote === undefined) return []
  const kex = check.kex ?? null
  return [{ remote: check.remote, transport, kex, pq: check.pq ?? classifyKex(kex), source: 'probe', at }]
}
