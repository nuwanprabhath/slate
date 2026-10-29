import { spawn } from 'node:child_process'
import { inheritedEnv } from './childEnv'

export interface GitResult {
  code: number
  stdout: Uint8Array
  stderr: string
  timedOut?: boolean
}

export interface GitRunOptions {
  cwd?: string
  env?: Record<string, string>
  input?: Uint8Array
  timeoutMs?: number
}

export type GitRunner = (args: string[], opts?: GitRunOptions) => Promise<GitResult>

export const LOCAL_TIMEOUT_MS = 10_000
export const NETWORK_TIMEOUT_MS = 60_000

const BASE_SSH_COMMAND = 'ssh -o BatchMode=yes'
/** Only what sshCommand builds (INV-PQ-6): git hands GIT_SSH_COMMAND to /bin/sh. */
export const SAFE_SSH_COMMAND = /^ssh -o BatchMode=yes( -o KexAlgorithms=\^?[a-z0-9@.,-]+)?$/

/** Git must never wait on a terminal or an SSH passphrase: a sync runs with nobody watching. */
export const PROMPT_FREE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: BASE_SSH_COMMAND,
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: ''
}

export interface NodeGitRunnerOptions {
  /** From `sshCommand`; without it git gets `PROMPT_FREE_ENV.GIT_SSH_COMMAND`. */
  sshCommand?: string
}

/** Runs git with arguments only (no shell), killing it after the timeout. */
export function nodeGitRunner(gitPath = 'git', runnerOpts: NodeGitRunnerOptions = {}): GitRunner {
  const sshEnv: Record<string, string> = {}
  if (runnerOpts.sshCommand !== undefined) {
    // git runs GIT_SSH_COMMAND through /bin/sh, so only a command sshCommand could have built gets in.
    if (!SAFE_SSH_COMMAND.test(runnerOpts.sshCommand)) throw new Error('GIT_SSH_COMMAND refused: not a command sshCommand builds')
    sshEnv.GIT_SSH_COMMAND = runnerOpts.sshCommand
  }
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(gitPath, args, {
        cwd: opts.cwd,
        env: { ...inheritedEnv(), ...PROMPT_FREE_ENV, ...sshEnv, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      })
      const out: Buffer[] = []
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, opts.timeoutMs ?? LOCAL_TIMEOUT_MS)
      child.stdout.on('data', (b: Buffer) => out.push(b))
      child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: timedOut ? -1 : (code ?? -1), stdout: new Uint8Array(Buffer.concat(out)), stderr, timedOut })
      })
      child.stdin.end(opts.input ? Buffer.from(opts.input) : undefined)
    })
}

/**
 * The child-process config that hands git a GitHub token. It lives only in that process's
 * environment, never in `.git/config` or a URL.
 */
export function tokenEnv(token: string, host = 'https://github.com/'): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${host}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  }
}

/** Hybrid (post-quantum + X25519) SSH key exchanges, most preferred first. */
export const PQ_KEX = ['mlkem768x25519-sha256', 'sntrup761x25519-sha512@openssh.com', 'sntrup761x25519-sha512'] as const
export type PqKex = (typeof PQ_KEX)[number]
export type KexPolicy = 'prefer' | 'require'

export interface SshKexProbe {
  /** Usable hybrids, in PQ_KEX order; always PQ_KEX's own strings. */
  hybrid: readonly PqKex[]
  /** `OpenSSH_<version>` from `ssh -V`, for diagnostics only; null when ssh did not run. */
  ssh: string | null
  /** Whether this ssh accepted `KexAlgorithms=^…`; false means the explicit list passed instead. */
  prepend: boolean
}

/** Thrown when policy 'require' meets an ssh with no hybrid key exchange. */
export class PqTransportUnavailable extends Error {
  override readonly name = 'PqTransportUnavailable'
  constructor(message = 'This ssh offers no post-quantum hybrid key exchange') {
    super(message)
  }
}

/** Classical exchanges after the hybrids when an older ssh refuses `^` (prepend to its defaults). */
const CLASSICAL_FALLBACK = ['curve25519-sha256', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'diffie-hellman-group16-sha512'] as const
/** `.invalid` never resolves, and `ssh -G` only prints the configuration it would use. */
const PROBE_HOST = 'slate-probe.invalid'
const PROBE_TIMEOUT_MS = 5_000

interface ProbeRun {
  code: number
  stdout: string
  stderr: string
}

function runSsh(spawnFn: typeof spawn, args: string[]): Promise<ProbeRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawnFn('ssh', args, { env: { ...inheritedEnv(), ...PROMPT_FREE_ENV }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true })
    } catch {
      resolve({ code: -1, stdout: '', stderr: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(-1)
    }, PROBE_TIMEOUT_MS)
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString()))
    child.stderr?.on('data', (b: Buffer) => (stderr += b.toString()))
    child.on('error', () => finish(-1))
    child.on('close', (code: number | null) => finish(code ?? -1))
  })
}

/** Hybrids ssh listed, picked by equality so only PQ_KEX's literals survive; sntrup's two names are aliases. */
function pickHybrids(listed: readonly string[]): PqKex[] {
  const picked: PqKex[] = PQ_KEX.filter((name) => listed.includes(name))
  return picked.includes('sntrup761x25519-sha512@openssh.com') ? picked.filter((name) => name !== 'sntrup761x25519-sha512') : picked
}

function kexValue(hybrid: readonly PqKex[], prepend: boolean): string {
  return prepend ? `^${hybrid.join(',')}` : [...hybrid, ...CLASSICAL_FALLBACK].join(',')
}

async function acceptsKex(spawnFn: typeof spawn, value: string): Promise<boolean> {
  const run = await runSsh(spawnFn, ['-F', 'none', '-G', '-o', 'BatchMode=yes', '-o', `KexAlgorithms=${value}`, PROBE_HOST])
  return run.code === 0
}

async function runProbe(spawnFn: typeof spawn): Promise<SshKexProbe> {
  const version = await runSsh(spawnFn, ['-V'])
  const ssh = /OpenSSH_[0-9A-Za-z.]{1,32}/.exec(version.stderr)?.[0] ?? null
  const listed = await runSsh(spawnFn, ['-Q', 'kex'])
  if (listed.code !== 0) return { hybrid: [], ssh, prepend: false }
  const hybrid = pickHybrids(listed.stdout.split('\n').map((line) => line.trim()))
  if (hybrid.length === 0) return { hybrid, ssh, prepend: false }
  if (await acceptsKex(spawnFn, kexValue(hybrid, true))) return { hybrid, ssh, prepend: true }
  if (await acceptsKex(spawnFn, kexValue(hybrid, false))) return { hybrid, ssh, prepend: false }
  return { hybrid: [], ssh, prepend: false }
}

let processProbe: Promise<SshKexProbe> | undefined

/**
 * Which hybrid key exchanges this machine's ssh offers: `ssh -Q kex` ∩ PQ_KEX, validated offline with
 * `ssh -G`. Once per process with the real spawn; a given `spawnFn` (tests) always probes afresh.
 */
export function probeSshKex(spawnFn?: typeof spawn): Promise<SshKexProbe> {
  if (spawnFn) return runProbe(spawnFn)
  processProbe ??= runProbe(spawn)
  return processProbe
}

/**
 * GIT_SSH_COMMAND for a probe: 'prefer' puts the hybrids ahead of ssh's defaults, 'require' offers only
 * them. Built from PQ_KEX literals alone, whatever the probe object holds (INV-PQ-6).
 */
export function sshCommand(probe: SshKexProbe, policy: KexPolicy): string {
  const hybrid = pickHybrids(probe.hybrid)
  if (hybrid.length === 0) {
    if (policy === 'require') throw new PqTransportUnavailable()
    return BASE_SSH_COMMAND
  }
  const value = policy === 'require' ? hybrid.join(',') : kexValue(hybrid, probe.prepend)
  return `${BASE_SSH_COMMAND} -o KexAlgorithms=${value}`
}
