import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThemeRunner, ThemeRunRequest } from './themeGenerator'

/**
 * The user's own `claude`, asked one question and given nothing to do but answer, as Apiary does.
 *
 * `--tools ""` leaves it no tools; `--no-session-persistence` keeps the exchange out of
 * ~/.claude/projects. It runs in a fresh empty directory that is removed afterwards.
 *
 * It is launched through the login shell, because that is what puts an nvm or Homebrew `claude` on
 * PATH for an app started from the Dock. The shell is handed a fixed script (`exec "$0" "$@"`) and
 * every argument as its own positional parameter: nothing the user typed is ever parsed by a shell.
 */

const loginShell = (): string => process.env.SHELL || '/bin/zsh'

function shellArgs(argv: string[]): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: argv[0]!, args: argv.slice(1) }
  return { cmd: loginShell(), args: ['-l', '-c', 'exec "$0" "$@"', ...argv] }
}

/** Where `claude` is on the login shell's PATH, or null. Asked once; the answer is cached. */
let found: Promise<string | null> | null = null
export function findClaude(): Promise<string | null> {
  found ??= new Promise((resolve) => {
    if (process.platform === 'win32') return resolve(null)
    const child = spawn(loginShell(), ['-l', '-c', 'command -v claude'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => { child.kill(); resolve(null) }, 10_000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const path = out.trim().split('\n').pop() ?? ''
      resolve(code === 0 && path.startsWith('/') ? path : null)
    })
  })
  return found
}

export class ClaudeOneShot implements ThemeRunner {
  private proc: ChildProcess | null = null
  private abort: (() => void) | null = null

  get busy(): boolean { return this.proc !== null }

  cancel(): void {
    this.abort?.()
  }

  async run(req: ThemeRunRequest): Promise<string> {
    if (this.proc !== null) throw new Error('Already working on a theme.')
    const bin = (await findClaude()) ?? 'claude'
    const flags = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--json-schema', JSON.stringify(req.jsonSchema)]
    const cwd = mkdtempSync(join(tmpdir(), 'slate-theme-'))
    const { cmd, args } = shellArgs([bin, ...flags, req.prompt])
    try {
      return await new Promise<string>((resolve, reject) => {
        // Its own process group, so cancel and the timeout end whatever it started too.
        const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
        this.proc = child
        let out = ''
        let err = ''
        let settled = false
        const kill = (): void => {
          try {
            if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
            else child.kill()
          } catch { /* already gone */ }
        }
        const finish = (fn: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); fn() } }
        this.abort = () => { finish(() => reject(new Error('Cancelled.'))); kill() }
        const timer = setTimeout(() => {
          finish(() => reject(new Error('Claude took too long to answer. Try again, or a shorter description.')))
          kill()
        }, req.timeoutMs)
        child.stdout!.on('data', (d: Buffer) => {
          out += d.toString('utf8')
          if (out.length > 256 * 1024) { finish(() => reject(new Error("Claude's reply was too large to be a theme."))); kill() }
        })
        child.stderr!.on('data', (d: Buffer) => { if (err.length < 4096) err += d.toString('utf8') })
        child.on('error', (e) => finish(() => reject(new Error(`Claude could not be run: ${e.message}`))))
        child.on('close', (code) => finish(() => {
          if (code === 0) resolve(out)
          else reject(new Error(`Claude could not be run (exit ${String(code)}). ${err.trim().split('\n').pop() ?? ''}`.trim()))
        }))
      })
    } finally {
      this.proc = null
      this.abort = null
      rmSync(cwd, { recursive: true, force: true })
    }
  }
}
