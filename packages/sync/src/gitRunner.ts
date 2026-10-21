import { spawn } from 'node:child_process'

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

/** Git must never wait on a terminal or an SSH passphrase: a sync runs with nobody watching. */
export const PROMPT_FREE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: ''
}

/** Runs git with arguments only (no shell), killing it after the timeout. */
export function nodeGitRunner(gitPath = 'git'): GitRunner {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(gitPath, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...PROMPT_FREE_ENV, ...opts.env },
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
