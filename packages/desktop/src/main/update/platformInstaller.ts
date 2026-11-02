import { access, constants, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InstallOutcome } from '../../shared/api'
import type { SecretBytes } from '../../shared/secret'
import { zeroSecret } from '../../shared/secret'
import type { ScopedLog } from '../log/logger'
import { runFile, spawnProgram } from '../proc'
import {
  DEB_INSTALL_SCRIPT, RELAUNCH_SCRIPT, SUDO_PROBE, SUDO_VALIDATE, bundleFromExecPath, isPasswordRefusal, macInstallScript,
  relaunchArgs, relaunchCommand, sha512Hex, sudoScript, systemdUserService,
} from './installCommands'
import type { PreviousInstall, UpdateBackend } from './updateService'

/** The install half of a backend, shared by the real one and the test-only fake. */
export type PlatformInstaller = Pick<UpdateBackend, 'needsPassword' | 'installDownloaded' | 'restart' | 'takePreviousInstall'>

export interface PlatformInstallerOptions {
  platform: NodeJS.Platform
  /** Where the macOS helper writes `update-result.json` for the next start. */
  resultFile: string
  /** `app.quit()`: the quit runs Slate's one orderly shutdown, so every handle closes first. */
  quit: () => void
  log: ScopedLog
  /** Where installers are downloaded: the one place a macOS install result may name a file to offer again. */
  downloadsDir: string
  /** The running binary; `process.execPath` unless a test places it elsewhere. */
  execPath?: string
  /** The running process's id and arguments, which the new instance copies; a test places them elsewhere. */
  pid?: number
  argv?: readonly string[]
}

/** The message sudo's refusal reads as, on every platform. */
export const PASSWORD_NOT_ACCEPTED = 'That password was not accepted.'

/** macOS runs a quarantined app from a read-only copy here; the helper's `mv` could never replace it. */
const TRANSLOCATED = 'Slate is running from a quarantined copy macOS made read-only. Move Slate.app to Applications, run `xattr -cr` on it, open it, then try again.'

/** apt can take minutes on a slow mirror or a busy dpkg lock. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 10_000
const VALIDATE_TIMEOUT_MS = 30_000
/** The most of a failing command's output kept to find its last line. */
const MAX_OUTPUT = 64 * 1024

interface RunResult {
  code: number | null
  stderr: string
}

/**
 * What a child reads on stdin: the password and a newline (what `sudo -S` takes), then the script
 * sudo's command reads, in a copy the writer zeroes once the pipe has taken it. Built in its own
 * ArrayBuffer (`new Uint8Array(n)` would keep a short password on V8's heap, where the move to the
 * pipe leaves an unwiped copy: T-ZERO-04, `moduleCopy`). Typed `SecretBytes`, so the lint rule keeps
 * watching it: a child's stdin is a sink it knows, and nothing here turns it into text. Null when there
 * is nothing to send.
 */
function stdinBytes(password: SecretBytes | null, script: string | null): SecretBytes | null {
  const body = script === null ? new Uint8Array(0) : new TextEncoder().encode(script)
  const head = password === null ? 0 : password.length + 1
  if (head + body.length === 0) return null
  const out: SecretBytes = new Uint8Array(new ArrayBuffer(head + body.length))
  if (password !== null) {
    for (let i = 0; i < password.length; i++) out[i] = password[i] ?? 0
    out[password.length] = 0x0a
  }
  out.set(body, head)
  return out
}

/**
 * Runs `file` with `args` and writes `input` to its stdin, then closes it: how a password and the
 * script reach `sudo -S`. `input` is zeroed once the pipe has taken it. Never a shell command string,
 * never argv, never a log line.
 */
export function runWithInput(file: string, args: readonly string[], opts: { input: SecretBytes | null; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnProgram(file, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stderr })
    }
    const timer = setTimeout(() => {
      stderr += `\n${file} did not finish in ${String(Math.round(opts.timeoutMs / 1000))} seconds.`
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8')
    })
    child.on('error', (e) => {
      stderr += e.message
      done(null)
    })
    child.on('close', (code) => done(code))
    const stdin = child.stdin
    if (stdin === null) return
    stdin.on('error', () => { /* sudo exited before reading: its exit code says why */ })
    const input = opts.input
    if (input === null) stdin.end()
    else stdin.end(input, () => input.fill(0))
  })
}

/**
 * Starts `file` detached, so it outlives this process, and resolves once its stdin has taken `input`
 * (zeroed after): Slate must not quit before the script is in the pipe.
 */
function launchDetached(file: string, args: readonly string[], input: SecretBytes | null): Promise<void> {
  return new Promise((resolve) => {
    const child = spawnProgram(file, args, { detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'ignore', 'ignore'] })
    // A helper that cannot start leaves Slate quitting with the old version in place.
    child.on('error', () => resolve())
    child.unref()
    const stdin = child.stdin
    if (input === null || stdin === null) {
      resolve()
      return
    }
    stdin.on('error', () => resolve())
    stdin.end(input, () => {
      input.fill(0)
      resolve()
    })
  })
}

/** The last thing a failed command said, as one line for the banner. */
function lastLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '').pop() ?? ''
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const MAX_MESSAGE = 300

/**
 * The helper's result file is plain JSON in userData, which another process of the account could have
 * written: only a well-formed version and a short one-line message are taken, and a file to offer again
 * only when it is a `.dmg` directly in the downloads folder.
 */
function parsePrevious(text: string, downloadsDir: string): PreviousInstall | null {
  const value = JSON.parse(text) as Record<string, unknown> | null
  if (typeof value !== 'object' || value === null) return null
  const { version, ok, message, path } = value
  if (typeof version !== 'string' || !VERSION.test(version) || typeof ok !== 'boolean' || typeof message !== 'string') return null
  const oneLine = message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
  const named = typeof path === 'string' && dirname(path) === downloadsDir && /\.dmg$/i.test(path) ? path : null
  return { version, ok, message: oneLine, path: named }
}

const writable = (path: string): Promise<boolean> => access(path, constants.W_OK).then(() => true, () => false)

/**
 * Installs a verified installer and restarts into it, on Ubuntu (.deb, installed while Slate runs)
 * and macOS (.dmg, installed by a helper after Slate quits). The password goes to sudo's stdin and
 * nowhere else: not to argv, a file, a log line or the state.
 */
export function createPlatformInstaller(opts: PlatformInstallerOptions): PlatformInstaller {
  const { log } = opts
  const execPath = opts.execPath ?? process.execPath
  const pid = opts.pid ?? process.pid
  const argv = opts.argv ?? process.argv

  const sudoPassword = async (password: SecretBytes | null): Promise<InstallOutcome | null> => {
    if (password === null) return null
    const result = await runWithInput(SUDO_VALIDATE.file, SUDO_VALIDATE.args, { input: stdinBytes(password, null), timeoutMs: VALIDATE_TIMEOUT_MS })
    if (result.code === 0) return null
    return isPasswordRefusal(result.code, result.stderr)
      ? { ok: false, reason: 'password', message: PASSWORD_NOT_ACCEPTED }
      : { ok: false, reason: 'install', message: lastLine(result.stderr) || 'sudo could not be run.' }
  }

  const installDeb = async (path: string, sha512: string, password: SecretBytes | null): Promise<InstallOutcome> => {
    // Root copies the download into a folder of its own and checks it before apt reads it (DEB_INSTALL_SCRIPT).
    const cmd = sudoScript(password !== null, [path, sha512Hex(sha512)])
    log.info('installing .deb', { path, withPassword: password !== null })
    const result = await runWithInput(cmd.file, cmd.args, { input: stdinBytes(password, DEB_INSTALL_SCRIPT), timeoutMs: INSTALL_TIMEOUT_MS })
    if (result.code === 0) {
      await rm(path, { force: true })
      log.info('installed .deb, deleted the download', { path })
      return { ok: true }
    }
    if (isPasswordRefusal(result.code, result.stderr) && password === null) {
      log.info('sudo wants a password after all')
      return { ok: false, reason: 'password-required', message: '' }
    }
    if (isPasswordRefusal(result.code, result.stderr)) {
      log.info('sudo refused the password')
      return { ok: false, reason: 'password', message: PASSWORD_NOT_ACCEPTED }
    }
    const message = lastLine(result.stderr) || `apt-get exited with ${String(result.code)}.`
    log.warn('install failed', { code: result.code, message })
    return { ok: false, reason: 'install', message }
  }

  const installDmg = async (path: string, sha512: string, password: SecretBytes | null, version: string): Promise<InstallOutcome> => {
    const bundle = bundleFromExecPath(execPath)
    if (bundle === null) return { ok: false, reason: 'install', message: 'Slate is not running from an app bundle.' }
    const refused = await sudoPassword(password)
    if (refused !== null) return refused
    const base = { pid, dmg: path, sha512Hex: sha512Hex(sha512), bundle, resultFile: opts.resultFile, version, uid: process.getuid?.() ?? 501 }
    if (password === null) {
      // Not root: a file the user can rewrite gives its writer nothing they did not have.
      const dir = await mkdtemp(join(tmpdir(), 'slate-install-'))
      const script = join(dir, 'install.sh')
      await writeFile(script, macInstallScript({ ...base, helperDir: dir }), { mode: 0o700 })
      await launchDetached('/bin/sh', [script], null)
    } else {
      // Root: the script arrives on sudo's stdin, after the password line, so there is no file to rewrite.
      const cmd = sudoScript(true, [])
      await launchDetached(cmd.file, cmd.args, stdinBytes(password, macInstallScript(base)))
    }
    log.info('install helper started; it installs once Slate has quit', { bundle, withPassword: password !== null })
    return { ok: true }
  }

  const relaunchLinux = async (): Promise<void> => {
    const cgroup = await readFile('/proc/self/cgroup', 'utf8').catch(() => '')
    const dir = await mkdtemp(join(tmpdir(), 'slate-relaunch-'))
    const script = join(dir, 'relaunch.sh')
    await writeFile(script, RELAUNCH_SCRIPT, { mode: 0o700 })
    const input = { pid, script, binary: execPath, args: relaunchArgs(argv) }
    const unit = systemdUserService(cgroup)
    if (unit !== null) {
      const command = relaunchCommand({ ...input, unit })
      log.info('starting the new version in a unit of its own once this one exits', { unit })
      const started = await runFile(command.file, command.args, { timeout: 15_000 }).then(() => true, (e: unknown) => {
        log.warn('systemd-run could not start the new version; trying setsid', { error: e instanceof Error ? e.message : String(e) })
        return false
      })
      if (started) return
    }
    const command = relaunchCommand({ ...input, unit: null })
    log.info('starting the new version once this one exits', { via: command.file })
    await launchDetached(command.file, command.args, null)
  }

  return {
    async needsPassword(path) {
      if (opts.platform === 'darwin') {
        if (execPath.includes('/AppTranslocation/')) throw new Error(TRANSLOCATED)
        const bundle = bundleFromExecPath(execPath)
        if (bundle === null) throw new Error('Slate is not running from an app bundle.')
        return !(await writable(bundle) && await writable(dirname(bundle)))
      }
      log.info('asking sudo whether it needs a password', { path })
      return runFile(SUDO_PROBE.file, SUDO_PROBE.args, { timeout: PROBE_TIMEOUT_MS }).then(() => false, () => true)
    },

    async installDownloaded(path, { password, version, sha512 }) {
      try {
        if (opts.platform === 'linux') return await installDeb(path, sha512, password)
        if (opts.platform === 'darwin') return await installDmg(path, sha512, password, version)
        return { ok: false, reason: 'install', message: `Slate cannot install updates on ${opts.platform}.` }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log.warn('install failed', { error: message })
        return { ok: false, reason: 'install', message }
      }
    },

    restart() {
      if (opts.platform !== 'linux') {
        opts.quit()
        return
      }
      // Quits even when the relaunch could not be started: the old binary's files are already replaced.
      relaunchLinux().catch((e: unknown) => log.warn('relaunch failed', { error: e instanceof Error ? e.message : String(e) })).finally(opts.quit)
    },

    async takePreviousInstall() {
      const text = await readFile(opts.resultFile, 'utf8').catch(() => undefined)
      if (text === undefined) return null
      await rm(opts.resultFile, { force: true })
      let previous: PreviousInstall | null
      try {
        previous = parsePrevious(text, opts.downloadsDir)
      } catch {
        return null
      }
      if (previous === null) return null
      const kept = previous.path !== null && await stat(previous.path).then((s) => s.isFile(), () => false)
      log.info('read the last install result', { ok: previous.ok, version: previous.version })
      return { ...previous, path: kept ? previous.path : null }
    },
  }
}
