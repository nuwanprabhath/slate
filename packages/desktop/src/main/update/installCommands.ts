/**
 * The commands and scripts Install and restart runs, as pure functions of what main already holds
 * (the verified installer's path, this process's pid and argv), so every quoting and every branch is
 * tested without running any of them. None of them carries the password: it reaches only sudo's
 * stdin (platformInstaller.ts).
 */

export interface Command {
  file: string
  args: string[]
}

/** `sudo -n true`: exits 0 when sudo would not ask for a password (NOPASSWD, or still cached). */
export const SUDO_PROBE: Command = { file: 'sudo', args: ['-n', 'true'] }

/** sudo reading the password from stdin, never cached (`-k`), with no prompt text on stderr. */
const SUDO_STDIN = ['-S', '-k', '-p', '']

/** `args` run as root, with the password read from stdin. */
export function sudoWithStdin(args: string[]): Command {
  return { file: 'sudo', args: [...SUDO_STDIN, ...args] }
}

/** Checks a password without running anything (`-v`), so a wrong one is known before quitting. */
export const SUDO_VALIDATE: Command = sudoWithStdin(['-v'])

/**
 * `program args` run as root, the password (when there is one) the only thing on sudo's stdin: the
 * scripts are files in the app's own Resources (root-owned when a package installed it), never text
 * that shares the pipe with the password, which a sudo that did not read it would hand to a root shell.
 * With no password it runs under `sudo -n`, which uses a NOPASSWD rule or a cached credential and
 * reads no password; `-S -k` would discard that cache.
 */
export function sudoRun(withPassword: boolean, program: string, args: string[]): Command {
  return withPassword ? sudoWithStdin([program, ...args]) : { file: 'sudo', args: ['-n', program, ...args] }
}

/** The message a re-hash that no longer matches the signed feed ends in, here and in the service. */
export const CHANGED_SINCE_VERIFIED = 'The downloaded file changed since it was verified, so it was not installed.'

/** The sha512 the feed names (base64) as the hex `sha512sum` prints, for a script to compare. */
export function sha512Hex(base64: string): string {
  return Array.from(atob(base64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

/**
 * Whether a failed `sudo -S` was sudo refusing the password rather than the command it ran failing.
 * sudo exits 1 and says so on stderr; apt-get exits 100. Only that one distinction is read.
 */
export function isPasswordRefusal(exitCode: number | null, stderr: string): boolean {
  return exitCode === 1 && /incorrect password|Sorry, try again|no password was provided|a password is required/i.test(stderr)
}

/**
 * The systemd user unit this process runs in, from `/proc/self/cgroup` (cgroup v2: `0::/user.slice/
 * user-1000.slice/user@1000.service/app.slice/run-u12.service`), or null when it is not in a service
 * of the user manager. A scope (what a desktop launcher gives an app) outlives its first process, so
 * only a `.service` needs a unit of its own for the new instance: stopping it kills its whole cgroup.
 */
export function systemdUserService(cgroup: string): string | null {
  for (const line of cgroup.split('\n')) {
    const parts = line.split(':').slice(2).join(':').split('/')
    const manager = parts.findIndex((p) => /^user@\d+\.service$/.test(p))
    if (manager === -1) continue
    const unit = parts.slice(manager + 1).reverse().find((p) => /\.(service|scope)$/.test(p))
    if (unit?.endsWith('.service')) return unit
  }
  return null
}

/** Names `systemd-run` passes on from its own environment (`--setenv=NAME`); the new instance needs a display. */
const PASSED_THROUGH = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'SLATE_USER_DATA']

/**
 * The arguments the new instance gets: exactly the ones this main process was started with.
 * Chromium adds its internal switches (`--type=`, `--field-trial-handle=`) only to child processes,
 * never to the main process's argv, so nothing is filtered.
 */
export function relaunchArgs(argv: readonly string[]): string[] {
  return argv.slice(1)
}

/**
 * Waits (up to about 60 s) for `$1`, the old pid, to exit, then `exec`s the rest of its arguments:
 * the single-instance lock is the old process's until then. Positional, so nothing is quoted, and
 * run as a file (`sh relaunch.sh …`): `proc.ts` refuses a shell given a command string.
 */
export const RELAUNCH_SCRIPT = `#!/bin/sh
rm -rf "$(dirname "$0")"
i=0
while kill -0 "$1" 2>/dev/null; do
  i=$((i+1)); [ "$i" -ge 300 ] && exit 1
  sleep 0.2
done
shift
exec "$@"
`

export interface RelaunchInput {
  pid: number
  /** The script `RELAUNCH_SCRIPT` was written to. */
  script: string
  /** The installed binary, which apt replaced in place (`/opt/Slate/slate`). */
  binary: string
  args: string[]
  /** From `systemdUserService`: null when Slate is not in a service of the systemd user manager. */
  unit: string | null
}

/**
 * Starts the new instance so that it outlives this one. In a systemd user service, a plain child is
 * killed with the service's cgroup when it stops, so the new instance gets a transient unit of its
 * own; otherwise a `setsid` helper in its own session is enough.
 */
export function relaunchCommand(input: RelaunchInput): Command {
  const tail = ['/bin/sh', input.script, String(input.pid), input.binary, ...input.args]
  if (input.unit === null) return { file: 'setsid', args: ['-f', ...tail] }
  return { file: 'systemd-run', args: ['--user', '--collect', '--quiet', ...PASSED_THROUGH.map((n) => `--setenv=${n}`), ...tail] }
}

/** The running `.app` bundle, from `process.execPath` (`…/Slate.app/Contents/MacOS/Slate`); never assumed to be in /Applications. */
export function bundleFromExecPath(execPath: string): string | null {
  const match = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match === null ? null : match[1] ?? null
}
