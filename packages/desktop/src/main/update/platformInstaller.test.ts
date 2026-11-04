import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScopedLog } from '../log/logger'
import { secretBytes } from '../../shared/secret'
import { sha512Hex } from './installCommands'
import { NOT_HERS, PASSWORD_NOT_ACCEPTED, SCRIPT_NOT_ROOTS, createPlatformInstaller, nobodyButRootChanges, onApplicationsVolume, runWithInput, stdinBytes, type PathOps } from './platformInstaller'

const PASSWORD = 'correct horse battery staple 7!'
/** What the signed feed names for the installers these tests write; only its hex reaches the script. */
const SHA512 = 'LHlL7dKoqg98gS2nfQv878dK+UoktbAkm4M20/hoJ2Qr0Kqsa3MSL4VmWy/Lll/MYjQFkpvOxduQ/vswentozA=='
const HEX = sha512Hex(SHA512)

let root: string
let shims: string
let scripts: string
const restore: string[] = []
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
  scripts = join(root, 'resources', 'update')
  mkdirSync(shims)
  mkdirSync(scripts, { recursive: true })
  vi.stubEnv('PATH', `${shims}:/usr/bin:/bin`)
  logged.length = 0
  quit.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const p of restore.splice(0)) chmodSync(p, 0o755)
  rmSync(root, { recursive: true, force: true })
})

const sudoPath = () => join(shims, 'sudo')

/** A `sudo` that records its arguments and what it read from stdin, then behaves as `body` says. */
function fakeSudo(body: string): { args: () => string; stdin: () => string } {
  const args = join(root, 'sudo.args')
  const stdin = join(root, 'sudo.stdin')
  writeFileSync(sudoPath(), `#!/bin/sh\necho "$*" >> '${args}'\n${body}\n`)
  chmodSync(sudoPath(), 0o700)
  return { args: () => (existsSync(args) ? readFileSync(args, 'utf8') : ''), stdin: () => (existsSync(stdin) ? readFileSync(stdin, 'utf8') : '') }
}
/** The stdin of the sudo it replaces, kept for the test to read. */
const readStdin = () => `cat >> '${join(root, 'sudo.stdin')}'`

const base = () => ({ resultFile: join(root, 'update-result.json'), downloadsDir: root, scriptsDir: scripts, sudo: sudoPath(), quit, log, rootOnly: (_path: string) => Promise.resolve(true), onApplicationsVolume: (_path: string) => Promise.resolve(true) })

function linux(execPath = '/opt/Slate/slate') {
  return createPlatformInstaller({ ...base(), platform: 'linux', execPath, pid: 4242, argv: [execPath, '--user-data-dir=/x'] })
}
function installer(file: string): string {
  const path = join(root, file)
  writeFileSync(path, 'deb')
  return path
}

describe('the stdin copy of a password', () => {
  it('is the password and a newline, in an ArrayBuffer of exactly that size, so no copy stays on the V8 heap', () => {
    const password = secretBytes('hunter2')
    const line = stdinBytes(password)
    expect(line).not.toBeNull()
    expect([...line!]).toEqual([...password, 0x0a])
    expect(line!.buffer.byteLength).toBe(password.length + 1)
    expect(line!.byteOffset).toBe(0)
    expect(line!.buffer).not.toBe(password.buffer)
    expect(stdinBytes(null)).toBeNull()
  })

  it('is zeroed once the pipe has taken it, after the program read it', async () => {
    const out = join(root, 'read')
    const program = join(shims, 'reader')
    writeFileSync(program, `#!/bin/sh\ncat > '${out}'\n`, { mode: 0o700 })
    const input = stdinBytes(secretBytes('hunter2'))
    const copy = [...input!]
    expect(await runWithInput(program, [], { input, timeoutMs: 10_000 })).toMatchObject({ code: 0 })
    expect([...readFileSync(out)]).toEqual(copy)
    expect([...input!].every((b) => b === 0)).toBe(true)
  })

  it('is zeroed when the program cannot be started at all', async () => {
    const input = stdinBytes(secretBytes('hunter2'))
    expect(await runWithInput(join(root, 'no-such-program'), [], { input, timeoutMs: 10_000 })).toMatchObject({ code: null })
    expect([...input!].every((b) => b === 0)).toBe(true)
  })

  it('is zeroed when proc.ts refuses to start the program (a throw before any child exists)', async () => {
    const input = stdinBytes(secretBytes('hunter2'))
    const result = await runWithInput('/bin/sh', ['-c', 'true'], { input, timeoutMs: 10_000 })
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('refuses')
    expect([...input!].every((b) => b === 0)).toBe(true)
  })
})

describe('nobodyButRootChanges: what "out of this account\'s reach" has to mean before root works there', () => {
  type Entry = { uid: number; mode: number; refused?: string | null }
  /** A tree of path -> owner, mode and what write access answers (EACCES unless said). */
  const tree = (entries: Record<string, Entry>): PathOps & { asked: string[] } => {
    const asked: string[] = []
    return {
      asked,
      lstat: (p) => (entries[p] === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(entries[p])),
      access: (p) => {
        asked.push(p)
        const refused = entries[p]?.refused === undefined ? 'EACCES' : entries[p].refused
        return Promise.resolve(refused === null ? null : Object.assign(new Error(refused), { code: refused }))
      },
    }
  }
  const rootDir = { uid: 0, mode: 0o40755 }
  const apps = { '/': rootDir, '/Applications': rootDir, '/Applications/Slate.app': rootDir }

  it('is true for a chain root owns, nobody else can write, and this account is refused on', async () => {
    const ops = tree(apps)
    expect(await nobodyButRootChanges('/Applications/Slate.app', ops)).toBe(true)
    // The file system root is judged by owner and mode: on macOS the sealed system volume answers EROFS to everyone.
    expect(ops.asked).toEqual(['/Applications/Slate.app', '/Applications'])
  })

  it('is false when this account can write any part of it', async () => {
    expect(await nobodyButRootChanges('/Applications/Slate.app', tree({ ...apps, '/Applications': { ...rootDir, refused: null } }))).toBe(false)
  })

  it('is false for a read-only volume the account mounted: it can unmount it and mount its own under the same name', async () => {
    const ops = tree({ '/': rootDir, '/Volumes': rootDir, '/Volumes/Slate': { uid: 501, mode: 0o40755, refused: 'EROFS' } })
    expect(await nobodyButRootChanges('/Volumes/Slate', ops)).toBe(false)
    // Even when the image's files claim root as their owner, a read-only mount is not "refused", it is changeable.
    expect(await nobodyButRootChanges('/Volumes/Slate', tree({ '/': rootDir, '/Volumes': rootDir, '/Volumes/Slate': { ...rootDir, refused: 'EROFS' } }))).toBe(false)
  })

  it('is false for a folder the account owns and has set to 0555: its owner can chmod it back', async () => {
    expect(await nobodyButRootChanges('/Applications/Slate.app', tree({ ...apps, '/Applications/Slate.app': { uid: 501, mode: 0o40555 } }))).toBe(false)
  })

  it('is false when group or others can write, even if root owns it', async () => {
    expect(await nobodyButRootChanges('/Applications/Slate.app', tree({ ...apps, '/Applications': { uid: 0, mode: 0o40775 } }))).toBe(false)
    expect(await nobodyButRootChanges('/Applications/Slate.app', tree({ ...apps, '/Applications': { uid: 0, mode: 0o41777 } }))).toBe(false)
  })

  it('is false for anything it cannot look at', async () => {
    expect(await nobodyButRootChanges('/Applications/Gone.app', tree(apps))).toBe(false)
  })
})

describe('onApplicationsVolume', () => {
  const devs = (map: Record<string, number>) => (p: string) => (map[p] === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(map[p]))

  it('is true for a folder on the volume /Applications is on, and false for a disk image\'s volume', async () => {
    expect(await onApplicationsVolume('/Applications/Utilities', devs({ '/Applications': 16777234, '/Applications/Utilities': 16777234 }))).toBe(true)
    expect(await onApplicationsVolume('/Volumes/Slate', devs({ '/Applications': 16777234, '/Volumes/Slate': 16777240 }))).toBe(false)
  })

  it('is false when either cannot be looked at', async () => {
    expect(await onApplicationsVolume('/Applications/Slate.app', devs({ '/Applications': 1 }))).toBe(false)
    expect(await onApplicationsVolume('/Applications/Slate.app', devs({ '/Applications/Slate.app': 1 }))).toBe(false)
  })
})

describe('Ubuntu: needsPassword', () => {
  it('is false when sudo would not ask, and true when it would', async () => {
    fakeSudo('exit 0')
    expect(await linux().needsPassword('/dl/a.deb')).toBe(false)
    fakeSudo('exit 1')
    expect(await linux().needsPassword('/dl/a.deb')).toBe(true)
  })
})

describe('Ubuntu: installDownloaded', () => {
  const script = () => join(scripts, 'install-deb.sh')

  it('runs the install script as root by path through sudo -n when no password is needed, then deletes the download', async () => {
    const sudo = fakeSudo(readStdin())
    const deb = installer('a.deb')
    expect(await linux().installDownloaded(deb, { password: null, version: '0.6.0', sha512: SHA512 })).toEqual({ ok: true })
    expect(sudo.args()).toBe(`-n /bin/sh ${script()} ${deb} ${HEX}\n`)
    expect(sudo.stdin()).toBe('')
    expect(existsSync(deb)).toBe(false)
  })

  it('sends the password to sudo on stdin and nothing else with it: not argv, not the log, not the outcome', async () => {
    const sudo = fakeSudo(readStdin())
    const deb = installer('b.deb')
    const outcome = await linux().installDownloaded(deb, { password: secretBytes(PASSWORD), version: '0.6.0', sha512: SHA512 })
    expect(outcome).toEqual({ ok: true })
    // Only the password: a script sharing the pipe would be run by sudo's shell if sudo did not read the password.
    expect(sudo.stdin()).toBe(`${PASSWORD}\n`)
    expect(sudo.args()).toBe(`-S -k -p  /bin/sh ${script()} ${deb} ${HEX}\n`)
    expect(sudo.args()).not.toContain(PASSWORD)
    expect(JSON.stringify(logged)).not.toContain(PASSWORD)
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD)
  })

  it('says a refused password was refused, keeping the download', async () => {
    fakeSudo('echo "Sorry, try again." >&2; exit 1')
    const deb = installer('c.deb')
    expect(await linux().installDownloaded(deb, { password: secretBytes('nope'), version: '0.6.0', sha512: SHA512 })).toEqual({ ok: false, reason: 'password', message: PASSWORD_NOT_ACCEPTED })
    expect(existsSync(deb)).toBe(true)
  })

  it('asks for a password when sudo wanted one after all (its cache expired since the probe)', async () => {
    fakeSudo('echo "sudo: a password is required" >&2; exit 1')
    expect(await linux().installDownloaded(installer('d.deb'), { password: null, version: '0.6.0', sha512: SHA512 })).toEqual({ ok: false, reason: 'password-required', message: '' })
  })

  it("reports the script's last line when the install itself fails, and keeps the download", async () => {
    fakeSudo('printf "E: first\\nE: Unable to locate package slate\\n" >&2; exit 100')
    const deb = installer('e.deb')
    expect(await linux().installDownloaded(deb, { password: null, version: '0.6.0', sha512: SHA512 })).toEqual({ ok: false, reason: 'install', message: 'E: Unable to locate package slate' })
    expect(existsSync(deb)).toBe(true)
  })

  it('reports a missing sudo as an install failure rather than throwing', async () => {
    const installerWithoutSudo = createPlatformInstaller({ ...base(), platform: 'linux', sudo: join(root, 'no-sudo'), execPath: '/opt/Slate/slate' })
    const outcome = await installerWithoutSudo.installDownloaded(installer('f.deb'), { password: null, version: '0.6.0', sha512: SHA512 })
    expect(outcome).toMatchObject({ ok: false, reason: 'install' })
  })

  it('runs no script that this account could rewrite as root: the real check refuses a script folder in a writable place', async () => {
    const sudo = fakeSudo('exit 0')
    const deb = installer('g.deb')
    const { rootOnly: _unused, ...withoutOverride } = base()
    const real = createPlatformInstaller({ ...withoutOverride, platform: 'linux', execPath: '/opt/Slate/slate' })
    expect(await real.installDownloaded(deb, { password: null, version: '0.6.0', sha512: SHA512 })).toEqual({ ok: false, reason: 'install', message: SCRIPT_NOT_ROOTS })
    expect(sudo.args()).toBe('')
    expect(existsSync(deb)).toBe(true)
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
  const mac = (execPath: string, over: Partial<ReturnType<typeof base>> = {}) =>
    createPlatformInstaller({ ...base(), ...over, platform: 'darwin', execPath, pid: 4242 })
  const bundle = () => {
    const app = join(root, 'Apps', 'Slate.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    return { app, exec: join(app, 'Contents', 'MacOS', 'Slate') }
  }
  /** A bundle and its folder this account cannot write, as when root owns them. */
  const rootsBundle = () => {
    const b = bundle()
    const parent = join(root, 'Apps')
    chmodSync(b.app, 0o555)
    chmodSync(parent, 0o555)
    restore.push(b.app, parent)
    return b
  }

  it('needs no password when the bundle and its folder are the account\'s own', async () => {
    expect(await mac(bundle().exec).needsPassword('/dl/Slate.dmg')).toBe(false)
  })

  it('refuses a quarantined copy macOS made read-only, before any password is asked', async () => {
    await expect(mac('/private/var/folders/x/AppTranslocation/ABC/d/Slate.app/Contents/MacOS/Slate').needsPassword('/dl/Slate.dmg')).rejects.toThrow(/quarantined copy/)
  })

  it('refuses a run that is not from an app bundle', async () => {
    await expect(mac('/opt/Slate/slate').needsPassword('/dl/Slate.dmg')).rejects.toThrow(/not running from an app bundle/)
    expect(await mac('/opt/Slate/slate').installDownloaded('/dl/Slate.dmg', { password: null, version: '1', sha512: SHA512 })).toMatchObject({ ok: false, reason: 'install' })
  })

  it('quits for the restart: the helper installs once the quit has finished', () => {
    mac(bundle().exec).restart()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('asks sudo whether it needs a password only when the folder is out of the account\'s reach', async () => {
    const { exec } = rootsBundle()
    fakeSudo('exit 1')
    expect(await mac(exec).needsPassword('/dl/Slate.dmg')).toBe(true)
    fakeSudo('exit 0')
    expect(await mac(exec).needsPassword('/dl/Slate.dmg')).toBe(false)
  })

  it('checks a password with sudo -v before anything quits, so a wrong one is known at once', async () => {
    const { exec } = rootsBundle()
    const sudo = fakeSudo('echo "Sorry, try again." >&2; exit 1')
    expect(await mac(exec).installDownloaded('/dl/Slate.dmg', { password: secretBytes('nope'), version: '1', sha512: SHA512 })).toEqual({ ok: false, reason: 'password', message: PASSWORD_NOT_ACCEPTED })
    expect(sudo.args()).toBe('-S -k -p  -v\n')
  })

  it('runs the helper as root by path with only the password on stdin, so sudo never hands a password to a shell', async () => {
    const { exec, app } = rootsBundle()
    const sudo = fakeSudo(readStdin())
    const dmg = join(root, 'Slate.dmg')
    const outcome = await mac(exec).installDownloaded(dmg, { password: secretBytes(PASSWORD), version: '0.6.0', sha512: SHA512 })
    expect(outcome).toEqual({ ok: true })
    const script = join(scripts, 'install-dmg.sh')
    const uid = String(process.getuid?.() ?? 501)
    // The detached helper's sudo reads its password after this returns.
    await vi.waitFor(() => expect(sudo.args().trim().split('\n')).toHaveLength(2), { timeout: 5000 })
    expect(sudo.args().trim().split('\n')).toEqual(['-S -k -p  -v', `-S -k -p  /bin/sh ${script} 4242 ${dmg} ${HEX} ${app} ${join(root, 'update-result.json')} 0.6.0 ${uid}`])
    await vi.waitFor(() => expect(sudo.stdin()).toBe(`${PASSWORD}\n${PASSWORD}\n`), { timeout: 5000 })
    expect(sudo.args()).not.toContain(PASSWORD)
    expect(JSON.stringify(logged)).not.toContain(PASSWORD)
  })

  it('refuses to run as root in a folder the account can change, where a swap under root would be possible', async () => {
    const { exec, app } = bundle()
    chmodSync(app, 0o555)
    restore.push(app)
    const sudo = fakeSudo('exit 0')
    await expect(mac(exec, { rootOnly: () => Promise.resolve(false) }).needsPassword('/dl/Slate.dmg')).rejects.toThrow(NOT_HERS)
    expect(await mac(exec, { rootOnly: () => Promise.resolve(false) }).installDownloaded('/dl/Slate.dmg', { password: secretBytes('x'), version: '1', sha512: SHA512 })).toEqual({ ok: false, reason: 'install', message: NOT_HERS })
    expect(sudo.args()).toBe('')
  })

  it('refuses to run as root in a disk image\'s volume, which the account mounted and could replace after Slate quits', async () => {
    const { exec } = rootsBundle()
    const sudo = fakeSudo('exit 0')
    const onImage = { onApplicationsVolume: (_path: string) => Promise.resolve(false) }
    await expect(mac(exec, onImage).needsPassword('/dl/Slate.dmg')).rejects.toThrow(NOT_HERS)
    expect(await mac(exec, onImage).installDownloaded('/dl/Slate.dmg', { password: secretBytes('x'), version: '1', sha512: SHA512 })).toEqual({ ok: false, reason: 'install', message: NOT_HERS })
    expect(sudo.args()).toBe('')
  })

  it('refuses to run a helper as root from a folder the account can change', async () => {
    const { exec } = rootsBundle()
    const sudo = fakeSudo('exit 0')
    // The folder is out of reach but the script's is not.
    const onlyApps = (path: string) => Promise.resolve(path.startsWith(join(root, 'Apps')))
    expect(await mac(exec, { rootOnly: onlyApps }).installDownloaded('/dl/Slate.dmg', { password: secretBytes('x'), version: '1', sha512: SHA512 })).toEqual({ ok: false, reason: 'install', message: SCRIPT_NOT_ROOTS })
    expect(sudo.args()).toBe('')
  })

  it('is not offered on another platform', async () => {
    const win = createPlatformInstaller({ ...base(), platform: 'win32' })
    expect(await win.installDownloaded('C:\\a.exe', { password: null, version: '1', sha512: SHA512 })).toMatchObject({ ok: false, reason: 'install' })
  })
})

describe('takePreviousInstall', () => {
  const read = () => linux().takePreviousInstall()
  const result = () => join(root, 'update-result.json')

  it('says nothing when no helper ran', async () => {
    expect(await read()).toBeNull()
  })

  it('reads a failure once, with the installer it kept, and deletes the file', async () => {
    const dmg = installer('Slate.dmg')
    writeFileSync(result(), JSON.stringify({ version: '0.6.0', ok: false, message: 'The disk image could not be opened.', path: dmg }))
    expect(await read()).toEqual({ version: '0.6.0', ok: false, message: 'The disk image could not be opened.', path: dmg })
    expect(await read()).toBeNull()
  })

  it('drops the path of an installer that is gone', async () => {
    writeFileSync(result(), JSON.stringify({ version: '0.6.0', ok: false, message: 'x', path: join(root, 'gone.dmg') }))
    expect(await read()).toMatchObject({ path: null })
  })

  it('takes a file to offer again only when it is a real .dmg directly in the downloads folder', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'slate-elsewhere-'))
    const forged = join(elsewhere, 'Slate.dmg')
    writeFileSync(forged, 'x')
    const notDmg = installer('run-me.command')
    const link = join(root, 'Link.dmg')
    symlinkSync(forged, link)
    for (const path of [forged, notDmg, link, join(root, 'sub', '..', 'x', 'Slate.dmg'), 42]) {
      writeFileSync(result(), JSON.stringify({ version: '0.6.0', ok: false, message: 'x', path }))
      expect(await read(), String(path)).toMatchObject({ path: null })
    }
    rmSync(elsewhere, { recursive: true, force: true })
  })

  it('refuses a version that is not a version, and keeps a message to one short line without control characters', async () => {
    writeFileSync(result(), JSON.stringify({ version: '<img src=x>', ok: false, message: 'x', path: null }))
    expect(await read()).toBeNull()
    writeFileSync(result(), JSON.stringify({ version: '0.6.0', ok: false, message: `first\n\n  second \u001b[31m ${'z'.repeat(1000)}`, path: null }))
    const previous = await read()
    expect(previous?.message.startsWith('first second [31m zzz')).toBe(true)
    expect(previous?.message.length).toBe(200)
  })

  it('does not read a link or a large file where the result should be, and removes it', async () => {
    const target = join(root, 'target.json')
    writeFileSync(target, JSON.stringify({ version: '0.6.0', ok: false, message: 'from a link', path: null }))
    symlinkSync(target, result())
    expect(await read()).toBeNull()
    expect(existsSync(result())).toBe(false)
    expect(existsSync(target)).toBe(true)
    writeFileSync(result(), JSON.stringify({ version: '0.6.0', ok: false, message: 'y'.repeat(10_000), path: null }))
    expect(await read()).toBeNull()
  })

  it('neither blocks on nor reads a FIFO where the result should be, and removes it', async () => {
    execFileSync('mkfifo', [result()])
    expect(await read()).toBeNull()
    expect(existsSync(result())).toBe(false)
  })

  it('treats a torn or foreign file as none', async () => {
    writeFileSync(result(), '{"version":')
    expect(await read()).toBeNull()
    writeFileSync(result(), JSON.stringify({ version: 1 }))
    expect(await read()).toBeNull()
    writeFileSync(result(), 'null')
    expect(await read()).toBeNull()
  })
})
