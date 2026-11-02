import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFile } from '../proc'
import {
  RELAUNCH_SCRIPT, SUDO_PROBE, SUDO_VALIDATE, bundleFromExecPath, isPasswordRefusal, relaunchArgs, relaunchCommand, sha512Hex, sudoRun, sudoWithStdin,
  systemdUserService,
} from './installCommands'

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

  it('runs a script file as root with the password the only thing on stdin; never a password in argv', () => {
    expect(sudoRun(true, '/bin/sh', ['/opt/Slate/resources/update/install-deb.sh', '/dl/a.deb', 'ab12'])).toEqual({
      file: 'sudo',
      args: ['-S', '-k', '-p', '', '/bin/sh', '/opt/Slate/resources/update/install-deb.sh', '/dl/a.deb', 'ab12'],
    })
    // No password: `sudo -n` uses a NOPASSWD rule or a cached credential; `-S -k` would throw the cache away.
    expect(sudoRun(false, '/bin/sh', ['/x.sh', '/dl/a.deb']).args).toEqual(['-n', '/bin/sh', '/x.sh', '/dl/a.deb'])
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
