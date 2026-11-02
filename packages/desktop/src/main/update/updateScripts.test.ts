import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFile } from '../proc'
import { CHANGED_SINCE_VERIFIED } from './installCommands'
import { runWithInput } from './platformInstaller'

/** The two scripts root runs, exactly as the packaged app ships them (resources/update), run here as the test's own user. */
const SCRIPTS = fileURLToPath(new URL('../../../resources/update/', import.meta.url))

// What the signed feed would name for the files these tests write ('dmg' and 'deb' as their whole content), in hex.
const DMG_HEX = '80ac74a3055a4ed549956eea2356ef8f4a01b27f31adaa7fd01233d2494b8c41a3d76a53ad5dfc0b028953f8e9bff174e8058549896fd2e953bbd2b1ee00f0df'
const DEB_HEX = '2c794bedd2a8aa0f7c812da77d0bfcefc74af94a24b5b0249b8336d3f86827642bd0aaac6b73122f85665b2fcb965fcc623405929bcec5db90fefb307a7b68cc'

const temps: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-scr-'))
  temps.push(dir)
  return dir
}
function shim(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  chmodSync(join(dir, name), 0o700)
}

describe('install-deb.sh', () => {
  async function run(content: string, expectedHex: string, opts: { aptExit?: number; stdin?: string } = {}) {
    const root = temp()
    const shims = join(root, 'shims')
    const log = join(root, 'apt.log')
    shim(shims, 'apt-get', `echo "$DEBIAN_FRONTEND $*" >> '${log}'\ncat > '${join(root, 'apt.stdin')}'\nexit ${String(opts.aptExit ?? 0)}`)
    const deb = join(root, 'Slate.deb')
    writeFileSync(deb, content)
    vi.stubEnv('PATH', `${shims}:/usr/bin:/bin`)
    const input = opts.stdin === undefined ? null : new TextEncoder().encode(opts.stdin)
    const result = await runWithInput('/bin/sh', [join(SCRIPTS, 'install-deb.sh'), deb, expectedHex], { input, timeoutMs: 20_000 })
    return { ...result, root, deb, apt: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }

  it('installs a copy it checked, not the file in Downloads, non-interactively', async () => {
    const r = await run('deb', DEB_HEX)
    expect(r.code).toBe(0)
    expect(r.apt).toMatch(/^noninteractive install -y --allow-downgrades \S+slate\.deb\n$/)
    expect(r.apt).not.toContain(r.deb)
  })

  it('installs nothing when the file no longer matches what the signed feed names, and says so word for word', async () => {
    const r = await run('swapped by someone', DEB_HEX)
    expect(r.code).toBe(1)
    expect(r.stderr.trim()).toBe(CHANGED_SINCE_VERIFIED)
    expect(r.apt).toBe('')
  })

  it("passes apt's exit status on, so a failed install is told from a refused password", async () => {
    expect((await run('deb', DEB_HEX, { aptExit: 100 })).code).toBe(100)
  })

  it('says so when the download is gone', async () => {
    const root = temp()
    const result = await runWithInput('/bin/sh', [join(SCRIPTS, 'install-deb.sh'), join(root, 'missing.deb'), DEB_HEX], { input: null, timeoutMs: 20_000 })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('could not be read')
  })

  it('never reads its stdin, where sudo may have left the password: nothing on it runs and nothing under it reads it', async () => {
    const marker = join(temp(), 'ran')
    const r = await run('deb', DEB_HEX, { stdin: `touch '${marker}'\nhunter2\n` })
    expect(r.code).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(r.root, 'apt.stdin'), 'utf8')).toBe('')
  })
})

describe('install-dmg.sh', () => {
  interface Opts {
    image?: 'ok' | 'fails'
    content?: string
    version?: string
    /** A `mv` that fails for these destinations (the new bundle's, and the old one's when putting it back). */
    mvFails?: 'stage' | 'all'
  }
  async function run(opts: Opts = {}) {
    const root = temp()
    const shims = join(root, 'shims')
    const log = join(root, 'log')
    const imageOpens = opts.image ?? 'ok'
    // hdiutil attach … -mountpoint <dir> <dmg>: makes the "disk image" hold a new app. ditto copies a bundle's contents into the folder.
    shim(shims, 'hdiutil', `echo "hdiutil $1" >> '${log}'
if [ "$1" = attach ]; then
  [ '${imageOpens}' = fails ] && exit 1
  echo "attached $*" >> '${log}'
  mp=""; while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mp=$2; shift; done
  mkdir -p "$mp/Slate.app/Contents" && echo new > "$mp/Slate.app/Contents/version"
fi
exit 0`)
    shim(shims, 'ditto', 'cp -R "$1/." "$2"')
    shim(shims, 'xattr', `echo "xattr $*" >> '${log}'`)
    shim(shims, 'open', `echo "open $*" >> '${log}'`)
    const parent = join(root, 'Apps')
    const app = join(parent, 'Slate.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'version'), 'old')
    if (opts.mvFails !== undefined) {
      const dest = opts.mvFails === 'stage' ? `case "$1" in *.slate-update-??????) [ "$2" = '${app}' ] && exit 1;; esac` : `[ "$2" = '${app}' ] && exit 1`
      shim(shims, 'mv', `${dest}\nexec /bin/mv "$@"`)
    }
    // A name with a quote and a space, which the result file's JSON must carry.
    const dmg = join(root, 'Slate "it\'s".dmg')
    writeFileSync(dmg, opts.content ?? 'dmg')
    const result = join(root, 'update-result.json')
    vi.stubEnv('PATH', `${shims}:/usr/bin:/bin`)
    // A pid that is not running, so the wait is over at once. A failed install exits 1, as it should; the result file says why.
    await runFile('/bin/sh', [join(SCRIPTS, 'install-dmg.sh'), '2147483646', dmg, DMG_HEX, app, result, opts.version ?? '0.6.0', '501'], {}).catch(() => undefined)
    return {
      // 'missing' when no app is at the path: the old one could not be put back.
      version: existsSync(join(app, 'Contents', 'version')) ? readFileSync(join(app, 'Contents', 'version'), 'utf8').trim() : 'missing',
      dmgKept: existsSync(dmg),
      result: JSON.parse(readFileSync(result, 'utf8')) as { version: string; ok: boolean; message: string; path: string },
      log: readFileSync(log, 'utf8'),
      leftovers: readdirSync(parent).filter((n) => n.startsWith('.slate-')),
      dmg,
    }
  }

  it('swaps the new app in beside the old, clears its quarantine, deletes the dmg, says so and opens Slate', async () => {
    const r = await run()
    expect(r.version).toBe('new')
    expect(r.dmgKept).toBe(false)
    expect(r.result).toEqual({ version: '0.6.0', ok: true, message: '', path: r.dmg })
    expect(r.log).toMatch(/xattr -cr .*Slate\.app/)
    expect(r.log).toMatch(/open -n .*Slate\.app/)
    expect(r.leftovers).toEqual([])
  })

  it('opens a copy it checked, not the file in Downloads, which another process could swap while it waits', async () => {
    const r = await run()
    const attached = r.log.split('\n').find((l) => l.startsWith('attached'))
    expect(attached).toBeDefined()
    expect(attached).not.toContain(r.dmg)
  })

  it('installs nothing when the file no longer matches what the signed feed names, keeping it and the old app', async () => {
    const r = await run({ content: 'a different disk image' })
    expect(r.version).toBe('old')
    expect(r.dmgKept).toBe(true)
    expect(r.result).toMatchObject({ ok: false, message: CHANGED_SINCE_VERIFIED })
    expect(r.log).not.toMatch(/attached/)
    expect(r.leftovers).toEqual([])
  })

  it('leaves the old app in place, keeps the dmg, reports the failure and opens Slate when the image cannot be opened', async () => {
    const r = await run({ image: 'fails' })
    expect(r.version).toBe('old')
    expect(r.dmgKept).toBe(true)
    expect(r.result).toMatchObject({ ok: false, message: 'The disk image could not be opened.', path: r.dmg })
    expect(r.log).toMatch(/open -n/)
    expect(r.log).not.toMatch(/xattr/)
  })

  it('puts the old app back when the new one cannot be moved into place, and says so', async () => {
    const r = await run({ mvFails: 'stage' })
    expect(r.version).toBe('old')
    expect(r.dmgKept).toBe(true)
    expect(r.result).toMatchObject({ ok: false, message: 'The new version could not be moved into place.' })
    expect(r.leftovers).toEqual([])
    expect(r.log).toMatch(/open -n/)
  })

  it('names the folder the old app is in when it cannot be put back either', async () => {
    const r = await run({ mvFails: 'all' })
    expect(r.result.ok).toBe(false)
    expect(r.result.message).toMatch(/could not be put back: it is at \.slate-update-\w+\.old\.$/)
    expect(r.leftovers.some((n) => n.endsWith('.old'))).toBe(true)
  })

  it('takes a version it can print and nothing else', async () => {
    expect((await run({ version: '<img src=x onerror=1>' })).result.version).toBe('unknown')
  })

  it('writes its result as the user and holds no way to put a password anywhere', () => {
    const text = readFileSync(join(SCRIPTS, 'install-dmg.sh'), 'utf8')
    expect(text).toContain('sudo -u "#$uid" tee "$result"')
    expect(text).not.toMatch(/chown|password/i)
    // Run as root it takes its commands from a PATH and a temp folder of its own, not the caller's.
    for (const script of ['install-dmg.sh', 'install-deb.sh']) {
      expect(readFileSync(join(SCRIPTS, script), 'utf8'), script).toContain('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; unset TMPDIR')
    }
  })

  // These run only as root, which a test is not: what they say is pinned here, and platformInstaller.test.ts pins the same rule in code.
  it('as root repeats the folder checks after Slate has quit, before it makes anything: owner, mode, and the volume', () => {
    const text = readFileSync(join(SCRIPTS, 'install-dmg.sh'), 'utf8')
    const check = text.indexOf("stat -L -f '%u %Lp'")
    expect(check).toBeGreaterThan(text.indexOf('while kill -0'))
    expect(check).toBeLessThan(text.indexOf('work=$(mktemp -d)'))
    expect(text).toContain('[ "$1" = 0 ] && [ $((0$2 & 022)) -eq 0 ]')
    expect(text).toContain('[ "$(stat -f %d "$parent")" = "$(stat -f %d /Applications)" ]')
  })

  it('deletes the download as the user when it runs as root: Downloads can be pointed anywhere', () => {
    expect(readFileSync(join(SCRIPTS, 'install-dmg.sh'), 'utf8')).toContain('sudo -u "#$uid" rm -f "$dmg"')
  })
})
