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

/** POSIX single-quoting, for the values a generated script holds as variables. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
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
 * Installs a verified `.deb` while Slate is still running. `DEBIAN_FRONTEND` keeps apt from asking and
 * is set by `env` as root's command, because sudo resets the environment it is started with.
 * With no password it runs under `sudo -n`, which uses a NOPASSWD rule or a cached credential and
 * reads nothing; `-S -k` would discard that cache and read an empty password.
 */
export function debInstallCommand(debPath: string, withPassword: boolean): Command {
  const apt = ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--allow-downgrades', debPath]
  return withPassword ? sudoWithStdin(apt) : { file: 'sudo', args: ['-n', ...apt] }
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

export interface MacScriptInput {
  pid: number
  dmg: string
  bundle: string
  /** `update-result.json` under userData: the next start reads it and deletes it. */
  resultFile: string
  version: string
  /** The logged-in user, so a helper running under sudo relaunches Slate as them, not as root. */
  uid: number
  /** Replaces the relaunch, for the integration test, which must not open anything. */
  relaunch?: string
}

/**
 * The helper that installs a verified `.dmg` after Slate has quit (a running bundle must not be
 * replaced). It swaps the new bundle in beside the old one on the same volume, so a failure part way
 * puts the old one back; clears the quarantine on the installed bundle; deletes the .dmg only on
 * success; writes a one-line result for the next start; and relaunches as the logged-in user.
 */
export function macInstallScript(input: MacScriptInput): string {
  const q = shellQuote
  const relaunch = input.relaunch
    ?? `if [ "$(id -u)" -eq 0 ]; then launchctl asuser ${String(input.uid)} sudo -u '#${String(input.uid)}' open -n "$app"; else open -n "$app"; fi`
  return `#!/bin/sh
pid=${String(input.pid)}
dmg=${q(input.dmg)}
app=${q(input.bundle)}
result=${q(input.resultFile)}
version_json=${q(JSON.stringify(input.version))}
dmg_json=${q(JSON.stringify(input.dmg))}
uid=${String(input.uid)}
parent=$(dirname "$app")
stage="$parent/.slate-update-$$.app"
old="$parent/.slate-old-$$.app"
mnt=""

relaunch() { ${relaunch}; }
report() {
  printf '{"version":%s,"ok":%s,"message":"%s","path":%s}\\n' "$version_json" "$1" "$2" "$dmg_json" > "$result"
  [ "$(id -u)" -eq 0 ] && chown "$uid" "$result"
}
detach() { [ -n "$mnt" ] && { hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -quiet -force; rmdir "$mnt"; }; mnt=""; }
fail() { rm -rf "$stage"; detach; report false "$1"; relaunch; rm -rf "$(dirname "$0")"; exit 1; }

i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -ge 300 ] && { report false "Slate did not quit in time, so the update was not installed."; rm -rf "$(dirname "$0")"; exit 1; }
  sleep 0.2
done

mnt=$(mktemp -d) || fail "Could not make a folder to open the disk image in."
hdiutil attach -nobrowse -quiet -noverify -mountpoint "$mnt" "$dmg" || { rmdir "$mnt"; mnt=""; fail "The disk image could not be opened."; }
new=""
for a in "$mnt"/*.app; do [ -d "$a" ] && { new=$a; break; }; done
[ -n "$new" ] || fail "The disk image holds no app."
ditto "$new" "$stage" || fail "The new version could not be copied out of the disk image."
detach
mv "$app" "$old" || fail "The installed version could not be moved aside."
if ! mv "$stage" "$app"; then mv "$old" "$app"; fail "The new version could not be moved into place."; fi
rm -rf "$old"
xattr -cr "$app"
rm -f "$dmg"
report true ""
relaunch
rm -rf "$(dirname "$0")"
`
}
