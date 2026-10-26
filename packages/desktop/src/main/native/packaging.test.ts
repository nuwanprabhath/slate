// Review R1: the packaged FIPS provider must be the exact pinned file, and a release must prove it
// starts in approved mode before it is published.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fipsConfigText } from './fipsConfig'

const desktop = join(__dirname, '../../..')
const nodeRequire = createRequire(__filename)
const target = `${process.platform}-${process.arch}`
const nativeDir = join(desktop, '..', 'native')
const addon = join(nativeDir, 'prebuilds', target, 'slate_native.node')
const provider = join(nativeDir, 'fips', target)
const smoke = join(desktop, 'scripts', 'smoke-native.cjs')

type BuilderConfig = { mac: { signIgnore?: string | string[] | null }; extraResources: Array<{ from: string; to: string }> }

function loadBuilder(env: Record<string, string>): BuilderConfig {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    delete nodeRequire.cache[nodeRequire.resolve(join(desktop, 'electron-builder.cjs'))]
    return nodeRequire(join(desktop, 'electron-builder.cjs')) as BuilderConfig
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'slate-smoke-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('C3 review N3: the packaged app carries the native components\' licences', () => {
  it('ships SQLCipher\'s BSD-3, OpenSSL\'s Apache-2.0 and the vendored binding\'s MIT text', () => {
    const entry = loadBuilder({}).extraResources.find((r) => r.from === '../native/licenses')
    expect(entry?.to).toBe('licenses')
    for (const [file, text] of [['SQLCipher-LICENSE.md', 'ZETETIC LLC'], ['OpenSSL-LICENSE.txt', 'Apache License'], ['better-sqlite3-multiple-ciphers-LICENSE', 'Joshua Wise']] as const) {
      const path = join(nativeDir, 'licenses', file)
      expect(existsSync(path), file).toBe(true)
      expect(readFileSync(path, 'utf8'), file).toContain(text)
    }
  })
})

describe('review R1: macOS signing never rewrites the pinned FIPS provider', () => {
  it('electron-builder leaves Resources/fips unsigned-over, with or without a Developer ID', () => {
    const envs: Array<Record<string, string>> = [{}, { CSC_LINK: 'base64-p12', CSC_KEY_PASSWORD: 'x' }]
    for (const env of envs) {
      const ignore = loadBuilder(env).mac.signIgnore
      const patterns = (Array.isArray(ignore) ? ignore : ignore ? [ignore] : []).map((p) => new RegExp(p))
      for (const file of ['/x/Slate.app/Contents/Resources/fips/fips.dylib', '/x/Slate.app/Contents/Resources/fips/fipsmodule.cnf']) {
        expect(patterns.some((p) => p.test(file)), `${file} with ${JSON.stringify(env)}`).toBe(true)
      }
      expect(patterns.some((p) => p.test('/x/Slate.app/Contents/MacOS/Slate'))).toBe(false)
    }
  })
})

describe('review R1: the release smoke check (scripts/smoke-native.cjs)', () => {
  it('writes the same OpenSSL config the app writes', () => {
    const { configText } = nodeRequire(smoke) as { configText: (dir: string) => string }
    expect(configText('/app/resources/fips')).toBe(fipsConfigText('/app/resources/fips'))
  })

  /** A packaged resources folder: app.asar.unpacked/out/native/slate_native.node and fips/. */
  function resources(name: string, withProvider: boolean): string {
    const dir = join(tmp, name)
    mkdirSync(join(dir, 'app.asar.unpacked', 'out', 'native'), { recursive: true })
    cpSync(addon, join(dir, 'app.asar.unpacked', 'out', 'native', 'slate_native.node'))
    if (withProvider) cpSync(provider, join(dir, 'fips'), { recursive: true })
    return dir
  }

  function run(dir: string, cwd?: string): { code: number; out: string } {
    try {
      return { code: 0, out: execFileSync(process.execPath, [smoke, dir], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }) }
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string }
      return { code: err.status, out: `${err.stdout}${err.stderr}` }
    }
  }

  // Needs the built addon (and the provider) from npm run -w @slate/native build:addon.
  it.skipIf(!existsSync(addon) || !existsSync(provider))('passes a packaged layout that starts in approved mode', () => {
    const r = run(resources('good', true))
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toMatchObject({ approvedMode: true, providers: 'base,fips', roundTrip: true })
  })

  // Needs the built addon (and the provider) from npm run -w @slate/native build:addon.
  it.skipIf(!existsSync(addon) || !existsSync(provider))('accepts the resources folder as a relative path, as release.yml passes it', () => {
    resources('relative', true)
    const r = run('relative', tmp)
    expect(r.code, r.out).toBe(0)
  })

  // Needs the built addon (and the provider) from npm run -w @slate/native build:addon.
  it.skipIf(!existsSync(addon))('fails a packaged layout whose provider is missing', () => {
    const r = run(resources('missing', false))
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/SCC_15|not in approved mode/)
  })
})
