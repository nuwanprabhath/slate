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
 * `/bin/sh -s -- args` run as root, the script arriving on sudo's stdin (after the password line, when
 * there is one). A file the user can rewrite must never be what root runs: any other process of this
 * account could change it while root waits. With no password it runs under `sudo -n`, which uses a
 * NOPASSWD rule or a cached credential and reads no password; `-S -k` would discard that cache.
 */
export function sudoScript(withPassword: boolean, args: string[]): Command {
  const sh = ['/bin/sh', '-s', '--', ...args]
  return withPassword ? sudoWithStdin(sh) : { file: 'sudo', args: ['-n', ...sh] }
}

/** The message a re-hash that no longer matches the signed feed ends in, here and in the service. */
export const CHANGED_SINCE_VERIFIED = 'The downloaded file changed since it was verified, so it was not installed.'

/** The sha512 the feed names (base64) as the hex `sha512sum` prints, for a script to compare. */
export function sha512Hex(base64: string): string {
  return Array.from(atob(base64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

/**
 * Run as root by `sudoScript(…, [deb, sha512Hex])`: copies the verified `.deb` into a folder root made
 * (the download sits in the user's own Downloads, which any process of the account can write), checks
 * the copy against the sha512 the signed feed names, and installs the copy. Positional, so nothing is
 * quoted. apt's exit status is the script's.
 */
export const DEB_INSTALL_SCRIPT = `work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT
cp "$1" "$work/slate.deb" || { echo "The downloaded file could not be read." >&2; exit 1; }
if command -v sha512sum >/dev/null 2>&1; then sum=$(sha512sum "$work/slate.deb"); else sum=$(shasum -a 512 "$work/slate.deb"); fi
[ "\${sum%% *}" = "$2" ] || { echo "${CHANGED_SINCE_VERIFIED}" >&2; exit 1; }
DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$work/slate.deb"
`

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
  /** `sha512Hex` of what the signed feed names for the dmg. */
  sha512Hex: string
  bundle: string
  /** `update-result.json` under userData: the next start reads it and deletes it. */
  resultFile: string
  version: string
  /** The logged-in user, so a helper running under sudo writes the result and relaunches Slate as them, not as root. */
  uid: number
  /** The folder holding the script when it runs from a file (not under sudo); deleted when it ends. */
  helperDir?: string
  /** Replaces the relaunch, for the integration test, which must not open anything. */
  relaunch?: string
}

/**
 * The helper that installs a verified `.dmg` after Slate has quit (a running bundle must not be
 * replaced). Under sudo it arrives on stdin (`sudoScript`), never from a file the user can rewrite.
 * It copies the dmg into a folder of its own and checks the copy against the signed feed's sha512
 * (the download sits in the user's Downloads) before opening it; swaps the new bundle in beside the
 * old one on the same volume, so a failure part way puts the old one back; clears the quarantine on the
 * installed bundle; deletes the dmg only on success; writes a one-line result as the user, for the next
 * start; and relaunches as the logged-in user.
 */
export function macInstallScript(input: MacScriptInput): string {
  const q = shellQuote
  const relaunch = input.relaunch
    ?? `if [ "$(id -u)" -eq 0 ]; then launchctl asuser ${String(input.uid)} sudo -u '#${String(input.uid)}' open -n "$app"; else open -n "$app"; fi`
  const cleanup = input.helperDir === undefined ? ':' : `rm -rf ${q(input.helperDir)}`
  return `#!/bin/sh
pid=${String(input.pid)}
dmg=${q(input.dmg)}
expected=${q(input.sha512Hex)}
app=${q(input.bundle)}
result=${q(input.resultFile)}
version_json=${q(JSON.stringify(input.version))}
dmg_json=${q(JSON.stringify(input.dmg))}
uid=${String(input.uid)}
parent=$(dirname "$app")
stage=""
old=""
work=""
mnt=""

relaunch() { ${relaunch}; }
cleanup() { ${cleanup}; }
report() {
  line=$(printf '{"version":%s,"ok":%s,"message":"%s","path":%s}' "$version_json" "$1" "$2" "$dmg_json")
  # As the user, so a link planted at the result path cannot make root write anywhere.
  if [ "$(id -u)" -eq 0 ]; then printf '%s\\n' "$line" | sudo -u "#$uid" tee "$result" >/dev/null; else printf '%s\\n' "$line" > "$result"; fi
}
unmount() { [ -n "$mnt" ] && { hdiutil detach -quiet "$mnt" || hdiutil detach -quiet -force "$mnt"; rmdir "$mnt"; }; mnt=""; }
tidy() { [ -n "$stage" ] && rm -rf "$stage"; unmount; [ -n "$work" ] && rm -rf "$work"; }
fail() { tidy; report false "$1"; relaunch; cleanup; exit 1; }

i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -ge 300 ] && { report false "Slate did not quit in time, so the update was not installed."; cleanup; exit 1; }
  sleep 0.2
done

work=$(mktemp -d) || fail "Could not make a folder to check the disk image in."
cp "$dmg" "$work/Slate.dmg" || fail "The disk image could not be read."
if command -v sha512sum >/dev/null 2>&1; then sum=$(sha512sum "$work/Slate.dmg"); else sum=$(shasum -a 512 "$work/Slate.dmg"); fi
[ "\${sum%% *}" = "$expected" ] || fail "${CHANGED_SINCE_VERIFIED}"

mnt=$(mktemp -d) || fail "Could not make a folder to open the disk image in."
hdiutil attach -nobrowse -quiet -noverify -mountpoint "$mnt" "$work/Slate.dmg" || { rmdir "$mnt"; mnt=""; fail "The disk image could not be opened."; }
new=""
for a in "$mnt"/*.app; do [ -d "$a" ] && { new=$a; break; }; done
[ -n "$new" ] || fail "The disk image holds no app."
stage=$(mktemp -d "$parent/.slate-update-XXXXXX") || fail "Could not make room for the new version next to the old one."
old="$stage.old"
ditto "$new" "$stage" || fail "The new version could not be copied out of the disk image."
chmod 755 "$stage"
unmount
mv "$app" "$old" || fail "The installed version could not be moved aside."
if ! mv "$stage" "$app"; then
  mv "$old" "$app" || { tidy; report false "The new version could not be installed and the old one could not be put back: it is at $(basename "$old")."; cleanup; exit 1; }
  fail "The new version could not be moved into place."
fi
stage=""
rm -rf "$old"
xattr -cr "$app"
rm -f "$dmg"
tidy
report true ""
relaunch
cleanup
`
}
