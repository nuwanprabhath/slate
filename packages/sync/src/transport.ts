import { PQ_KEX, SAFE_SSH_COMMAND } from './gitRunner'

/** Same union as the desktop's `PqLevel`; `unknown` means the transport did not say. */
export type PqLevel = 'hybrid' | 'classical' | 'unknown'

/** TLS groups that carry a post-quantum component. */
const HYBRID_TLS_GROUPS: readonly string[] = ['X25519MLKEM768', 'SecP256r1MLKEM768', 'SecP384r1MLKEM1024']
const HYBRID_KEX: readonly string[] = [...PQ_KEX, ...HYBRID_TLS_GROUPS]

/** The key exchange ssh reports at `-v`: `debug1: kex: algorithm: <name>`. */
export function parseSshKex(stderr: string): string | null {
  return /^debug1: kex: algorithm: ([A-Za-z0-9@._-]+)[ \t\r]*$/m.exec(stderr)?.[1] ?? null
}

/**
 * The TLS group in curl's `SSL connection using TLSv1.3 / <cipher> / <group> / <sigalg>` line. Reads that
 * one line only: the rest of a GIT_TRACE_CURL trace holds the Authorization header and is never copied.
 * Backends that print no group (SecureTransport) give null.
 */
export function parseCurlTls(trace: string): string | null {
  const group = /SSL connection using TLSv[0-9.]+ \/ [^/\r\n]+ \/ ([A-Za-z0-9_-]+) \//.exec(trace)?.[1]
  return group === undefined || group === 'UNDEF' ? null : group
}

export function classifyKex(name: string | null): PqLevel {
  if (name === null) return 'unknown'
  return HYBRID_KEX.includes(name) ? 'hybrid' : 'classical'
}

const DEFAULT_PORT: Record<string, number> = { 'git-ssh': 22, 'git-https': 443, 'git-http': 80 }
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/

export type TransportKind = 'ssh' | 'https'

/**
 * How `git ls-remote` reaches a remote, and the host-level id (`git-ssh:github.com`) to record it under:
 * no user, path, query or token. Null for local paths and anything else.
 */
export function remoteTransport(url: string): { kind: TransportKind; remote: string } | null {
  const text = url.trim()
  let scheme: 'git-ssh' | 'git-https' | 'git-http'
  let host: string
  let port: number | undefined
  const scp = /^(?:[^/@:\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/\/)/.exec(text)
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) && !/^[A-Za-z]:[\\/]/.test(text)) {
    scheme = 'git-ssh'
    host = scp[1]!
  } else {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    const p = parsed.protocol
    if (p === 'ssh:' || p === 'git+ssh:' || p === 'ssh+git:') scheme = 'git-ssh'
    else if (p === 'https:') scheme = 'git-https'
    else if (p === 'http:') scheme = 'git-http'
    else return null
    host = parsed.hostname
    port = parsed.port === '' ? undefined : Number(parsed.port)
  }
  host = host.toLowerCase()
  if (!HOST.test(host)) return null
  const shownPort = port !== undefined && port !== DEFAULT_PORT[scheme] ? `:${port}` : ''
  return { kind: scheme === 'git-ssh' ? 'ssh' : 'https', remote: `${scheme}:${host}${shownPort}` }
}

/** A sshCommand-built command plus `-v`, so ssh reports its key exchange. Anything else is refused. */
export function verboseSshCommand(command: string): string {
  if (!SAFE_SSH_COMMAND.test(command)) throw new Error('ssh -v refused: not a command sshCommand builds')
  return `${command} -v`
}
