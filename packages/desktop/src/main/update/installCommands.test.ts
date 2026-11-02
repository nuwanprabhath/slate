import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFile } from '../proc'
import {
  CHANGED_SINCE_VERIFIED, DEB_INSTALL_SCRIPT, RELAUNCH_SCRIPT, SUDO_PROBE, SUDO_VALIDATE, bundleFromExecPath, isPasswordRefusal, macInstallScript, relaunchArgs,
  relaunchCommand, sha512Hex, shellQuote, sudoScript, sudoWithStdin, systemdUserService,
} from './installCommands'
import { runWithInput } from './platformInstaller'

// What the signed feed would name for the files these tests write ('dmg' and 'deb' as their whole content).
const DMG_B64 = 'gKx0owVaTtVJlW7qI1bvj0oBsn8xrap/0BIz0klLjEGj12pTrV38CwKJU/jpv/F06AWFSYlv0ulTu9Kx7gDw3w=='
const DMG_HEX = '80ac74a3055a4ed549956eea2356ef8f4a01b27f31adaa7fd01233d2494b8c41a3d76a53ad5dfc0b028953f8e9bff174e8058549896fd2e953bbd2b1ee00f0df'
const DEB_B64 = 'LHlL7dKoqg98gS2nfQv878dK+UoktbAkm4M20/hoJ2Qr0Kqsa3MSL4VmWy/Lll/MYjQFkpvOxduQ/vswentozA=='
const DEB_HEX = '2c794bedd2a8aa0f7c812da77d0bfcefc74af94a24b5b0249b8336d3f86827642bd0aaac6b73122f85665b2fcb965fcc623405929bcec5db90fefb307a7b68cc'

const temps: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-cmd-'))
  temps.push(dir)
  return dir
}

describe('sudo commands', () => {
  it('reads the password from stdin, never caches it and prints no prompt', () => {
    expect(sudoWithStdin(['true'])).toEqual({ file: 'sudo', args: ['-S', '-k', '-p', '', 'true'] })
    expect(SUDO_VALIDATE.args).toEqual(['-S', '-k', '-p', '', '-v'])
    expect(SUDO_PROBE).toEqual({ file: 'sudo', args: ['-n', 'true'] })
  })

  it('runs a script given on stdin as root, so no file the user can rewrite is what root runs; never a password in argv', () => {
    expect(sudoScript(true, ['/dl/a.deb', 'ab12'])).toEqual({ file: 'sudo', args: ['-S', '-k', '-p', '', '/bin/sh', '-s', '--', '/dl/a.deb', 'ab12'] })
    // No password: `sudo -n` uses a NOPASSWD rule or a cached credential; `-S -k` would throw the cache away.
    expect(sudoScript(false, ['/dl/a.deb']).args).toEqual(['-n', '/bin/sh', '-s', '--', '/dl/a.deb'])
  })

  it('turns the feed\'s base64 sha512 into the hex a script compares', () => {
    expect(sha512Hex(DMG_B64)).toBe(DMG_HEX)
    expect(sha512Hex(DEB_B64)).toBe(DEB_HEX)
  })

  it('tells sudo refusing a password from the command failing', () => {
    expect(isPasswordRefusal(1, 'Sorry, try again.')).toBe(true)
    expect(isPasswordRefusal(1, 'sudo: 1 incorrect password attempt')).toBe(true)
    expect(isPasswordRefusal(1, 'sudo: a password is required')).toBe(true)
    expect(isPasswordRefusal(100, 'E: Unable to locate package')).toBe(false)
    expect(isPasswordRefusal(1, 'E: dpkg was interrupted')).toBe(false)
    expect(isPasswordRefusal(null, 'Sorry, try again.')).toBe(false)
  })
})

/** The script root runs for a .deb, run here as the test's user with apt-get replaced by a recorder. */
describe('DEB_INSTALL_SCRIPT', () => {
  async function run(content: string, expectedHex: string, aptExit = 0) {
    const root = temp()
    const shims = join(root, 'shims')
    mkdirSync(shims)
    const log = join(root, 'apt.log')
    writeFileSync(join(shims, 'apt-get'), `#!/bin/sh\necho "$DEBIAN_FRONTEND $*" >> '${log}'\ncp "$5" '${join(root, 'seen.deb')}' 2>/dev/null\nexit ${String(aptExit)}\n`, { mode: 0o700 })
    const deb = join(root, 'Slate.deb')
    writeFileSync(deb, content)
    vi.stubEnv('PATH', `${shims}:/usr/bin:/bin`)
    const result = await runWithInput('/bin/sh', ['-s', '--', deb, expectedHex], { input: new TextEncoder().encode(DEB_INSTALL_SCRIPT), timeoutMs: 20_000 })
    return { ...result, deb, apt: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }

  it('installs a copy it checked, not the file in Downloads, non-interactively', async () => {
    const r = await run('deb', DEB_HEX)
    expect(r.code).toBe(0)
    expect(r.apt).toMatch(/^noninteractive install -y --allow-downgrades \S+slate\.deb\n$/)
    expect(r.apt).not.toContain(r.deb)
  })

  it('installs nothing when the file no longer matches what the signed feed names', async () => {
    const r = await run('swapped by someone', DEB_HEX)
    expect(r.code).toBe(1)
    expect(r.stderr.trim()).toBe(CHANGED_SINCE_VERIFIED)
    expect(r.apt).toBe('')
  })

  it("passes apt's exit status on, so a failed install is told from a refused password", async () => {
    expect((await run('deb', DEB_HEX, 100)).code).toBe(100)
  })

  it('says so when the download is gone', async () => {
    const root = temp()
    const result = await runWithInput('/bin/sh', ['-s', '--', join(root, 'missing.deb'), DEB_HEX], { input: new TextEncoder().encode(DEB_INSTALL_SCRIPT), timeoutMs: 20_000 })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('could not be read')
  })
})

describe('systemdUserService', () => {
  it('finds the service Slate was started in under the user manager', () => {
    expect(systemdUserService('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u12.service\n')).toBe('run-u12.service')
  })

  it('leaves a desktop launcher alone: its scope outlives its first process', () => {
    expect(systemdUserService('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-slate-4242.scope\n')).toBeNull()
  })

  it('is null outside the user manager and for an empty or odd cgroup file', () => {
    expect(systemdUserService('0::/system.slice/ssh.service\n')).toBeNull()
    expect(systemdUserService('')).toBeNull()
    expect(systemdUserService('12:cpu:/foo\n')).toBeNull()
  })
})

describe('relaunch', () => {
  const base = { pid: 4242, script: '/tmp/slate-relaunch-x/relaunch.sh', binary: '/opt/Slate/slate', args: ['--user-data-dir=/home/me/data'] }

  it('runs the helper as a file, because proc.ts refuses a shell given a command string', () => {
    for (const unit of [null, 'run-u1.service']) {
      const { args } = relaunchCommand({ ...base, unit })
      expect(args).not.toContain('-c')
      expect(args.slice(-5)).toEqual(['/bin/sh', base.script, '4242', '/opt/Slate/slate', '--user-data-dir=/home/me/data'])
    }
  })

  it('uses setsid unless Slate runs in a service, which gets its own transient unit so stopping it cannot kill the new one', () => {
    expect(relaunchCommand({ ...base, unit: null })).toMatchObject({ file: 'setsid', args: expect.arrayContaining(['-f']) })
    const unit = relaunchCommand({ ...base, unit: 'run-u1.service' })
    expect(unit.file).toBe('systemd-run')
    expect(unit.args).toEqual(expect.arrayContaining(['--user', '--collect', '--setenv=DISPLAY', '--setenv=WAYLAND_DISPLAY', '--setenv=SLATE_USER_DATA']))
  })

  it('passes the arguments this process was started with, minus the binary', () => {
    expect(relaunchArgs(['/opt/Slate/slate', '--user-data-dir=/x', '--flag'])).toEqual(['--user-data-dir=/x', '--flag'])
  })

  it('has a helper that waits for the old pid, then execs the rest of its arguments', async () => {
    const dir = temp()
    const helper = join(dir, 'helper')
    mkdirSync(helper)
    const script = join(helper, 'relaunch.sh')
    writeFileSync(script, RELAUNCH_SCRIPT, { mode: 0o700 })
    const out = join(dir, 'out')
    const target = join(dir, 'target.sh')
    writeFileSync(target, `#!/bin/sh\nprintf '%s|%s' "$1" "$2" > '${out}'\n`, { mode: 0o700 })
    // A pid that is not running: the wait is over at once, so the helper execs the target with its arguments.
    await runFile('/bin/sh', [script, '2147483646', target, 'a b', "c'd"], {})
    expect(readFileSync(out, 'utf8')).toBe("a b|c'd")
    // It deletes its own folder before it starts waiting.
    expect(existsSync(helper)).toBe(false)
  })
})

describe('bundleFromExecPath', () => {
  it('finds the running bundle wherever it is installed', () => {
    expect(bundleFromExecPath('/Applications/Slate.app/Contents/MacOS/Slate')).toBe('/Applications/Slate.app')
    expect(bundleFromExecPath('/Users/me/My Apps/Slate.app/Contents/MacOS/Slate')).toBe('/Users/me/My Apps/Slate.app')
  })

  it('is null for anything that is not a bundle', () => {
    expect(bundleFromExecPath('/opt/Slate/slate')).toBeNull()
    expect(bundleFromExecPath('/Applications/Slate.app/Contents/Frameworks/x')).toBeNull()
  })
})

describe('shellQuote', () => {
  it('survives a quote and a space', () => {
    expect(shellQuote("it's a path")).toBe(`'it'\\''s a path'`)
  })
})

/** The macOS helper, run for real under /bin/sh with hdiutil, ditto and xattr replaced by small stand-ins. */
describe('macInstallScript', () => {
  async function run(opts: { attach: 'ok' | 'fails'; content?: string }) {
    const root = temp()
    const shims = join(root, 'shims')
    mkdirSync(shims)
    const log = join(root, 'log')
    const shim = (name: string, body: string) => {
      writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(shims, name), 0o700)
    }
    // hdiutil attach … -mountpoint <dir> <dmg>: makes the "disk image" hold a new app.
    shim('hdiutil', `echo "hdiutil $1" >> '${log}'
if [ "$1" = attach ]; then
  [ '${opts.attach}' = fails ] && exit 1
  echo "attached $*" >> '${log}'
  mp=""; while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mp=$2; shift; done
  mkdir -p "$mp/Slate.app/Contents" && echo new > "$mp/Slate.app/Contents/version"
fi
exit 0`)
    shim('ditto', `cp -R "$1/." "$2"`)
    shim('xattr', `echo "xattr $*" >> '${log}'`)
    const parent = join(root, 'Apps')
    mkdirSync(join(parent, 'Slate.app', 'Contents'), { recursive: true })
    writeFileSync(join(parent, 'Slate.app', 'Contents', 'version'), 'old')
    const dmg = join(root, "Slate it's.dmg")
    writeFileSync(dmg, opts.content ?? 'dmg')
    const result = join(root, 'update-result.json')
    const helper = join(root, 'helper')
    mkdirSync(helper)
    const script = join(helper, 'install.sh')
    writeFileSync(script, macInstallScript({ pid: 2147483646, dmg, sha512Hex: DMG_HEX, bundle: join(parent, 'Slate.app'), resultFile: result, version: '0.6.0', uid: 501, helperDir: helper, relaunch: `echo relaunched >> '${log}'` }), { mode: 0o700 })
    vi.stubEnv('PATH', `${shims}:/usr/bin:/bin`)
    // A failed install exits 1, as it should; the result file says why.
    await runFile('/bin/sh', [script], {}).catch(() => undefined)
    return {
      version: readFileSync(join(parent, 'Slate.app', 'Contents', 'version'), 'utf8').trim(),
      dmgKept: existsSync(dmg),
      result: JSON.parse(readFileSync(result, 'utf8')) as { version: string; ok: boolean; message: string; path: string },
      log: readFileSync(log, 'utf8'),
      leftovers: ['.slate-update', '.slate-old'].filter((p) => readdirSync(parent).some((n) => n.startsWith(p))),
      helperGone: !existsSync(helper),
      dmg,
    }
  }
  it('swaps the new app in beside the old, clears its quarantine, deletes the dmg, says so and relaunches', async () => {
    const r = await run({ attach: 'ok' })
    expect(r.version).toBe('new')
    expect(r.dmgKept).toBe(false)
    expect(r.result).toEqual({ version: '0.6.0', ok: true, message: '', path: r.dmg })
    expect(r.log).toMatch(/xattr -cr .*Slate\.app/)
    expect(r.log).toMatch(/relaunched/)
    expect(r.leftovers).toEqual([])
    expect(r.helperGone).toBe(true)
  })

  it('leaves the old app in place, keeps the dmg and reports the failure when the image cannot be opened', async () => {
    const r = await run({ attach: 'fails' })
    expect(r.version).toBe('old')
    expect(r.dmgKept).toBe(true)
    expect(r.result).toMatchObject({ ok: false, message: 'The disk image could not be opened.', path: r.dmg })
    expect(r.log).toMatch(/relaunched/)
    expect(r.log).not.toMatch(/xattr/)
  })

  it('opens a copy it checked, not the file in Downloads, which another process could swap while it waits', async () => {
    const r = await run({ attach: 'ok' })
    const attached = r.log.split('\n').find((l) => l.startsWith('attached'))
    expect(attached).toBeDefined()
    expect(attached).not.toContain(r.dmg)
  })

  it('installs nothing when the file no longer matches what the signed feed names, keeping it and the old app', async () => {
    const r = await run({ attach: 'ok', content: 'a different disk image' })
    expect(r.version).toBe('old')
    expect(r.dmgKept).toBe(true)
    expect(r.result).toMatchObject({ ok: false, message: CHANGED_SINCE_VERIFIED })
    expect(r.log).not.toMatch(/attached/)
    expect(r.leftovers).toEqual([])
  })

  it('writes its result as the user when it runs as root, so a link planted at the result path cannot make root write anywhere', () => {
    const script = macInstallScript({ pid: 1, dmg: '/d.dmg', sha512Hex: 'ab', bundle: '/A/Slate.app', resultFile: '/r', version: '1', uid: 501 })
    expect(script).toContain('sudo -u "#$uid" tee "$result"')
    expect(script).not.toMatch(/chown/)
    // Run from stdin under sudo it has no folder of its own to delete: `rm -rf "$(dirname "$0")"` would be `rm -rf .`.
    expect(script).not.toMatch(/dirname "\$0"/)
  })

  it('never holds a password: it takes none', () => {
    expect(macInstallScript({ pid: 1, dmg: '/d.dmg', sha512Hex: 'ab', bundle: '/A/Slate.app', resultFile: '/r', version: '1', uid: 501 })).not.toMatch(/password/i)
  })
})
