import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScopedLog } from '../log/logger'
import { secretBytes } from '../../shared/secret'
import { createPlatformInstaller, PASSWORD_NOT_ACCEPTED } from './platformInstaller'

const PASSWORD = 'correct horse battery staple 7!'

let root: string
let shims: string
const quit = vi.fn()
const logged: unknown[] = []
const log: ScopedLog = {
  info: (m, f) => void logged.push([m, f]),
  warn: (m, f) => void logged.push([m, f]),
  error: (m, f) => void logged.push([m, f]),
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slate-inst-'))
  shims = join(root, 'shims')
  mkdirSync(shims)
  vi.stubEnv('PATH', `${shims}:/usr/bin:/bin`)
  logged.length = 0
  quit.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** A `sudo` that records its arguments and what it read from stdin, then behaves as `body` says. */
function fakeSudo(body: string): { args: () => string; stdin: () => string } {
  const args = join(root, 'sudo.args')
  const stdin = join(root, 'sudo.stdin')
  writeFileSync(join(shims, 'sudo'), `#!/bin/sh\necho "$*" >> '${args}'\n${body}\n`)
  chmodSync(join(shims, 'sudo'), 0o700)
  return { args: () => (existsSync(args) ? readFileSync(args, 'utf8') : ''), stdin: () => (existsSync(stdin) ? readFileSync(stdin, 'utf8') : '') }
}
/** The stdin of the sudo it replaces, kept for the test to read. */
const readStdin = () => `cat >> '${join(root, 'sudo.stdin')}'`

function linux(execPath = '/opt/Slate/slate') {
  return createPlatformInstaller({ platform: 'linux', resultFile: join(root, 'update-result.json'), quit, log, execPath, pid: 4242, argv: [execPath, '--user-data-dir=/x'] })
}
function installer(file: string): string {
  const path = join(root, file)
  writeFileSync(path, 'deb')
  return path
}

describe('Ubuntu: needsPassword', () => {
  it('is false when sudo would not ask, and true when it would', async () => {
    fakeSudo('exit 0')
    expect(await linux().needsPassword('/dl/a.deb')).toBe(false)
    fakeSudo('exit 1')
    expect(await linux().needsPassword('/dl/a.deb')).toBe(true)
  })
})

describe('Ubuntu: installDownloaded', () => {
  it('installs with sudo -n when no password is needed, then deletes the download', async () => {
    const sudo = fakeSudo('exit 0')
    const deb = installer('a.deb')
    expect(await linux().installDownloaded(deb, { password: null, version: '0.6.0' })).toEqual({ ok: true })
    expect(sudo.args()).toBe(`-n env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades ${deb}\n`)
    expect(existsSync(deb)).toBe(false)
  })

  it('sends the password to sudo on stdin only: not argv, not the log, not the outcome', async () => {
    const sudo = fakeSudo(readStdin())
    const deb = installer('b.deb')
    const outcome = await linux().installDownloaded(deb, { password: secretBytes(PASSWORD), version: '0.6.0' })
    expect(outcome).toEqual({ ok: true })
    expect(sudo.stdin()).toBe(`${PASSWORD}\n`)
    expect(sudo.args()).toBe(`-S -k -p  env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades ${deb}\n`)
    expect(sudo.args()).not.toContain(PASSWORD)
    expect(JSON.stringify(logged)).not.toContain(PASSWORD)
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD)
  })

  it('says a refused password was refused, keeping the download', async () => {
    fakeSudo('echo "Sorry, try again." >&2; exit 1')
    const deb = installer('c.deb')
    expect(await linux().installDownloaded(deb, { password: secretBytes('nope'), version: '0.6.0' })).toEqual({ ok: false, reason: 'password', message: PASSWORD_NOT_ACCEPTED })
    expect(existsSync(deb)).toBe(true)
  })

  it('asks for a password when sudo wanted one after all (its cache expired since the probe)', async () => {
    fakeSudo('echo "sudo: a password is required" >&2; exit 1')
    expect(await linux().installDownloaded(installer('d.deb'), { password: null, version: '0.6.0' })).toEqual({ ok: false, reason: 'password-required', message: '' })
  })

  it("reports apt's last line when the install itself fails, and keeps the download", async () => {
    fakeSudo('printf "E: first\\nE: Unable to locate package slate\\n" >&2; exit 100')
    const deb = installer('e.deb')
    expect(await linux().installDownloaded(deb, { password: null, version: '0.6.0' })).toEqual({ ok: false, reason: 'install', message: 'E: Unable to locate package slate' })
    expect(existsSync(deb)).toBe(true)
  })

  it('reports a missing sudo as an install failure rather than throwing', async () => {
    vi.stubEnv('PATH', shims)
    const outcome = await linux().installDownloaded(installer('f.deb'), { password: null, version: '0.6.0' })
    expect(outcome).toMatchObject({ ok: false, reason: 'install', message: expect.stringContaining('sudo') as string })
  })
})

describe('Ubuntu: restart', () => {
  it('starts the new version through setsid with the old pid and arguments, then quits', async () => {
    const out = join(root, 'setsid.args')
    writeFileSync(join(shims, 'setsid'), `#!/bin/sh\necho "$*" > '${out}'\n`)
    chmodSync(join(shims, 'setsid'), 0o700)
    linux().restart()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1), { timeout: 5000 })
    await vi.waitFor(() => expect(existsSync(out)).toBe(true), { timeout: 5000 })
    const args = readFileSync(out, 'utf8').trim()
    expect(args).toMatch(/^-f \/bin\/sh \S+relaunch\.sh 4242 \/opt\/Slate\/slate --user-data-dir=\/x$/)
  })

  it('quits even when the new version could not be started: the old files are already replaced', async () => {
    linux().restart()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1), { timeout: 5000 })
  })
})

describe('macOS', () => {
  const mac = (execPath: string) => createPlatformInstaller({ platform: 'darwin', resultFile: join(root, 'update-result.json'), quit, log, execPath, pid: 4242 })
  const bundle = () => {
    const app = join(root, 'Apps', 'Slate.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    return { app, exec: join(app, 'Contents', 'MacOS', 'Slate') }
  }

  it('needs no password when the bundle and its folder are writable', async () => {
    expect(await mac(bundle().exec).needsPassword('/dl/Slate.dmg')).toBe(false)
  })

  it('refuses a quarantined copy macOS made read-only, before any password is asked', async () => {
    await expect(mac('/private/var/folders/x/AppTranslocation/ABC/d/Slate.app/Contents/MacOS/Slate').needsPassword('/dl/Slate.dmg')).rejects.toThrow(/quarantined copy/)
  })

  it('refuses a run that is not from an app bundle', async () => {
    await expect(mac('/opt/Slate/slate').needsPassword('/dl/Slate.dmg')).rejects.toThrow(/not running from an app bundle/)
    expect(await mac('/opt/Slate/slate').installDownloaded('/dl/Slate.dmg', { password: null, version: '1' })).toMatchObject({ ok: false, reason: 'install' })
  })

  it('quits for the restart: the helper installs once the quit has finished', () => {
    mac(bundle().exec).restart()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('checks a password with sudo -v before anything quits, so a wrong one is known at once', async () => {
    const sudo = fakeSudo('echo "Sorry, try again." >&2; exit 1')
    expect(await mac(bundle().exec).installDownloaded('/dl/Slate.dmg', { password: secretBytes('nope'), version: '1' })).toEqual({ ok: false, reason: 'password', message: PASSWORD_NOT_ACCEPTED })
    expect(sudo.args()).toBe('-S -k -p  -v\n')
  })

  it('is not offered on another platform', async () => {
    const win = createPlatformInstaller({ platform: 'win32', resultFile: join(root, 'r.json'), quit, log })
    expect(await win.installDownloaded('C:\\a.exe', { password: null, version: '1' })).toMatchObject({ ok: false, reason: 'install' })
  })
})

describe('takePreviousInstall', () => {
  const read = () => linux().takePreviousInstall()
  it('says nothing when no helper ran', async () => {
    expect(await read()).toBeNull()
  })

  it('reads a failure once, with the installer it kept, and deletes the file', async () => {
    const dmg = installer('Slate.dmg')
    writeFileSync(join(root, 'update-result.json'), JSON.stringify({ version: '0.6.0', ok: false, message: 'The disk image could not be opened.', path: dmg }))
    expect(await read()).toEqual({ version: '0.6.0', ok: false, message: 'The disk image could not be opened.', path: dmg })
    expect(await read()).toBeNull()
  })

  it('drops the path of an installer that is gone', async () => {
    writeFileSync(join(root, 'update-result.json'), JSON.stringify({ version: '0.6.0', ok: false, message: 'x', path: join(root, 'gone.dmg') }))
    expect(await read()).toMatchObject({ path: null })
  })

  it('treats a torn or foreign file as none', async () => {
    writeFileSync(join(root, 'update-result.json'), '{"version":')
    expect(await read()).toBeNull()
    writeFileSync(join(root, 'update-result.json'), JSON.stringify({ version: 1 }))
    expect(await read()).toBeNull()
    writeFileSync(join(root, 'update-result.json'), 'null')
    expect(await read()).toBeNull()
  })
})
