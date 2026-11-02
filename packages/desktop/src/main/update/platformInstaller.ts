import { access, constants, lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InstallOutcome } from '../../shared/api'
import type { SecretBytes } from '../../shared/secret'
import type { ScopedLog } from '../log/logger'
import { runFile, spawnProgram } from '../proc'
import {
  RELAUNCH_SCRIPT, SUDO_PROBE, SUDO_VALIDATE, bundleFromExecPath, isPasswordRefusal, relaunchArgs, relaunchCommand, sha512Hex, sudoRun, systemdUserService,
  type Command,
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
  /** The packaged app's `resources/update` (`install-deb.sh`, `install-dmg.sh`): what root runs, by path. */
  scriptsDir: string
  /** Whether no process of this account can change `path`, nor anything above it: the test for running it as root. */
  rootOnly?: (path: string) => Promise<boolean>
  /** Whether a macOS bundle is on the volume /Applications is on: root never works in a disk image's volume, which the account mounted. */
  onApplicationsVolume?: (path: string) => Promise<boolean>
  /** The sudo to run, by its full path so no PATH of ours chooses it. */
  sudo?: string
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
const NOT_A_BUNDLE = 'Slate is not running from an app bundle.'
/** A bundle owned by someone else in a folder this account can change: root would be working in a place an attacker could swap under it. */
export const NOT_HERS = 'Slate.app is in a place your account can change, or on a disk image, so Slate will not replace it as root. Use Download, and drag the new Slate into Applications.'
export const SCRIPT_NOT_ROOTS = 'The update script is in a folder your account can change, so Slate will not run it as root. Use Download, and install the new version yourself.'

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
 * What `sudo -S` reads on stdin: the password and a newline, and nothing else (the scripts it runs are
 * files). Built in its own ArrayBuffer: `new Uint8Array(n)` would keep a short password on V8's heap,
 * where the move to the pipe leaves an unwiped copy (T-ZERO-04, `moduleCopy`). Typed `SecretBytes`, so
 * the lint rule keeps watching it. Null when there is no password.
 */
export function stdinBytes(password: SecretBytes | null): SecretBytes | null {
  if (password === null) return null
  const out: SecretBytes = new Uint8Array(new ArrayBuffer(password.length + 1))
  for (let i = 0; i < password.length; i++) out[i] = password[i] ?? 0
  out[password.length] = 0x0a
  return out
}

/**
 * Runs `file` with `args` and writes `input` to its stdin, then closes it: how a password reaches
 * `sudo -S`. `input` is zeroed once the pipe has taken it, and also when the program cannot be started
 * at all. Never a shell command string, never argv, never a log line.
 */
export function runWithInput(file: string, args: readonly string[], opts: { input: SecretBytes | null; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const input = opts.input
    let child: ReturnType<typeof spawnProgram>
    try {
      child = spawnProgram(file, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (e) {
      input?.fill(0)
      resolve({ code: null, stderr: e instanceof Error ? e.message : String(e) })
      return
    }
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
      input?.fill(0)
      done(null)
    })
    child.on('close', (code) => done(code))
    const stdin = child.stdin
    if (stdin === null) {
      input?.fill(0)
      return
    }
    stdin.on('error', () => { /* sudo exited before reading: its exit code says why */ })
    if (input === null) stdin.end()
    else stdin.end(input, () => input.fill(0))
  })
}

/**
 * Starts `file` detached, so it outlives this process, and resolves once its stdin has taken `input`
 * (zeroed after, and also when it cannot be started): Slate must not quit before the password is in
 * the pipe.
 */
function launchDetached(file: string, args: readonly string[], input: SecretBytes | null): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProgram>
    try {
      child = spawnProgram(file, args, { detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'ignore', 'ignore'] })
    } catch {
      input?.fill(0)
      resolve()
      return
    }
    // A helper that cannot start leaves Slate quitting with the old version in place.
    child.on('error', () => {
      input?.fill(0)
      resolve()
    })
    child.unref()
    const stdin = child.stdin
    if (input === null || stdin === null) {
      input?.fill(0)
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
const MAX_MESSAGE = 200
/** The helper's result is a line or two; anything bigger is not from the helper. */
const MAX_RESULT_BYTES = 4096

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
  // Control characters are not part of a sentence for the banner.
  const oneLine = Array.from(message, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
  const named = typeof path === 'string' && dirname(path) === downloadsDir && /\.dmg$/i.test(path) ? path : null
  return { version, ok, message: oneLine, path: named }
}

const writable = (path: string): Promise<boolean> => access(path, constants.W_OK).then(() => true, () => false)

/** What `nobodyButRootChanges` asks of the file system; a test supplies its own. */
export interface PathOps {
  lstat(path: string): Promise<{ uid: number; mode: number }>
  /** null when this account can write `path`, else why it cannot. */
  access(path: string): Promise<NodeJS.ErrnoException | null>
}
const realOps: PathOps = {
  lstat: (path) => lstat(path),
  access: (path) => access(path, constants.W_OK).then(() => null, (e: NodeJS.ErrnoException) => e),
}

/**
 * True only when root owns `path` and every folder above it, none of them is writable by group or
 * others, and this account is refused write on each (EACCES or EPERM). Not enough: "this account cannot
 * write it now" also describes a read-only volume the account mounted (it can unmount it and mount its
 * own under the same name) and a folder it owns and has set to 0555 (it can chmod it back). The file
 * system root itself is checked by owner and mode only: on macOS it is the sealed system volume, which
 * answers EROFS to everyone.
 */
export async function nobodyButRootChanges(path: string, ops: PathOps = realOps): Promise<boolean> {
  for (let p = path; ; p = dirname(p)) {
    const info = await ops.lstat(p).catch(() => null)
    if (info === null || info.uid !== 0 || (info.mode & 0o022) !== 0) return false
    if (dirname(p) === p) return true
    const refused = await ops.access(p)
    if (refused === null || (refused.code !== 'EACCES' && refused.code !== 'EPERM')) return false
  }
}

/** Whether `path` is on the same volume as /Applications, which a mounted disk image never is. */
async function onApplicationsVolume(path: string): Promise<boolean> {
  const [here, apps] = await Promise.all([stat(path), stat('/Applications')]).catch(() => [null, null] as const)
  return here !== null && apps !== null && here.dev === apps.dev
}

/**
 * Installs a verified installer and restarts into it, on Ubuntu (.deb, installed while Slate runs)
 * and macOS (.dmg, installed by a helper after Slate quits). What root runs is a script in the app's
 * own Resources, run by path, with the password the only thing on stdin; it goes to sudo's stdin and
 * nowhere else: not to argv, a file, a log line or the state.
 */
export function createPlatformInstaller(opts: PlatformInstallerOptions): PlatformInstaller {
  const { log } = opts
  const execPath = opts.execPath ?? process.execPath
  const pid = opts.pid ?? process.pid
  const argv = opts.argv ?? process.argv
  const rootOnly = opts.rootOnly ?? ((path: string) => nobodyButRootChanges(path))
  const sameVolume = opts.onApplicationsVolume ?? onApplicationsVolume
  const sudoFile = opts.sudo ?? '/usr/bin/sudo'
  const withSudo = (cmd: Command): Command => (cmd.file === 'sudo' ? { ...cmd, file: sudoFile } : cmd)
  const probeSudo = (): Promise<boolean> => {
    const probe = withSudo(SUDO_PROBE)
    return runFile(probe.file, probe.args, { timeout: PROBE_TIMEOUT_MS }).then(() => true, () => false)
  }

  /**
   * How the new Slate.app goes in. `user`: the bundle and its folder are this account's. `root`: neither
   * the folder nor anything above it, nor the script, can be changed by this account, so a process of it
   * cannot swap anything under root. Anything between those (a root-owned bundle in a folder the account
   * can change) is refused rather than run as root in a place an attacker could reach.
   */
  const macPlan = async (bundle: string): Promise<'user' | 'root'> => {
    if (await writable(bundle) && await writable(dirname(bundle))) return 'user'
    if (!await sameVolume(dirname(bundle)) || !await rootOnly(dirname(bundle))) throw new Error(NOT_HERS)
    if (!await rootOnly(join(opts.scriptsDir, 'install-dmg.sh'))) throw new Error(SCRIPT_NOT_ROOTS)
    return 'root'
  }

  const sudoPassword = async (password: SecretBytes | null): Promise<InstallOutcome | null> => {
    if (password === null) return null
    const validate = withSudo(SUDO_VALIDATE)
    const result = await runWithInput(validate.file, validate.args, { input: stdinBytes(password), timeoutMs: VALIDATE_TIMEOUT_MS })
    if (result.code === 0) return null
    return isPasswordRefusal(result.code, result.stderr)
      ? { ok: false, reason: 'password', message: PASSWORD_NOT_ACCEPTED }
      : { ok: false, reason: 'install', message: lastLine(result.stderr) || 'sudo could not be run.' }
  }

  const installDeb = async (path: string, sha512: string, password: SecretBytes | null): Promise<InstallOutcome> => {
    const script = join(opts.scriptsDir, 'install-deb.sh')
    if (!await rootOnly(script)) return { ok: false, reason: 'install', message: SCRIPT_NOT_ROOTS }
    const cmd = withSudo(sudoRun(password !== null, '/bin/sh', [script, path, sha512Hex(sha512)]))
    log.info('installing .deb', { path, withPassword: password !== null })
    const result = await runWithInput(cmd.file, cmd.args, { input: stdinBytes(password), timeoutMs: INSTALL_TIMEOUT_MS })
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
    if (bundle === null) return { ok: false, reason: 'install', message: NOT_A_BUNDLE }
    const plan = await macPlan(bundle)
    const script = join(opts.scriptsDir, 'install-dmg.sh')
    const args = [script, String(pid), path, sha512Hex(sha512), bundle, opts.resultFile, version, String(process.getuid?.() ?? 501)]
    if (plan === 'user') {
      await launchDetached('/bin/sh', args, null)
    } else {
      const refused = await sudoPassword(password)
      if (refused !== null) return refused
      const cmd = withSudo(sudoRun(password !== null, '/bin/sh', args))
      await launchDetached(cmd.file, cmd.args, stdinBytes(password))
    }
    log.info('install helper started; it installs once Slate has quit', { bundle, plan, withPassword: password !== null })
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
        if (bundle === null) throw new Error(NOT_A_BUNDLE)
        if (await macPlan(bundle) === 'user') return false
        return !await probeSudo()
      }
      log.info('asking sudo whether it needs a password', { path })
      return !await probeSudo()
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
      // A regular file of a few lines: a link, or a big file, is not what the helper wrote.
      const info = await lstat(opts.resultFile).catch(() => undefined)
      if (info === undefined) return null
      const text = info.isFile() && info.size <= MAX_RESULT_BYTES ? await readFile(opts.resultFile, 'utf8').catch(() => undefined) : undefined
      await rm(opts.resultFile, { force: true })
      if (text === undefined) return null
      let previous: PreviousInstall | null
      try {
        previous = parsePrevious(text, opts.downloadsDir)
      } catch {
        return null
      }
      if (previous === null) return null
      const named = previous.path
      // lstat: a link named x.dmg in Downloads is not the installer the helper kept.
      const kept = named !== null && await lstat(named).then((s) => s.isFile(), () => false)
      log.info('read the last install result', { ok: previous.ok, version: previous.version })
      return { ...previous, path: kept ? named : null }
    },
  }
}
