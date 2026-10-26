import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowlist, read, ROOT } from './repo'

/**
 * What the packaged app and its renderer are allowed to loosen. C8 tightens the CSP and C12 the
 * fuses; these tests only stop either from getting weaker in the meantime.
 */
describe('renderer CSP (src/renderer/index.html)', () => {
  const html = read('packages/desktop/src/renderer/index.html')
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''

  it('exists', () => {
    expect(csp, 'the renderer page needs its Content-Security-Policy meta tag').not.toBe('')
  })

  it("never allows 'unsafe-eval' (WebAssembly's 'wasm-unsafe-eval' is a different, narrower grant)", () => {
    expect(csp.split(/\s+/)).not.toContain("'unsafe-eval'")
  })

  it('keeps every directive it has: default-src, script-src, connect-src', () => {
    for (const d of ['default-src', 'script-src', 'connect-src']) expect(csp, d).toContain(`${d} `)
  })

  // Red team 1a: the dev policy (ws:, http://localhost:*, http: images) shipped in the built app.
  const sources = (policy: string) => policy.split(';').flatMap((d) => {
    const [name, ...values] = d.trim().split(/\s+/)
    return values.map((v) => `${name!} ${v}`)
  })
  const DEV_PINNED = ["default-src 'self'", "script-src 'self'", "script-src 'unsafe-inline'", "script-src 'wasm-unsafe-eval'", "style-src 'self'", "style-src 'unsafe-inline'", "img-src 'self'", 'img-src data:', 'img-src blob:', 'img-src slate-blob:', 'img-src https:', 'img-src http:', "connect-src 'self'", 'connect-src ws:', 'connect-src http://localhost:*']

  it('the development policy grants nothing beyond today\'s sources (it may only shrink)', () => {
    expect(sources(csp).filter((s) => !DEV_PINNED.includes(s))).toEqual([])
  })

  it('the built app gets the production policy: no network, no plain http, no dev server', async () => {
    const { PRODUCTION_CSP, withProductionCsp } = await import('../../packages/desktop/src/shared/csp')
    const built = /content="([^"]+)"/.exec(withProductionCsp(html))?.[1] ?? ''
    expect(built).toBe(PRODUCTION_CSP)
    const prod = sources(built)
    expect(prod.filter((s) => s.startsWith('connect-src'))).toEqual(["connect-src 'self'"])
    for (const loose of ['connect-src ws:', 'connect-src http://localhost:*', 'img-src http:', "script-src 'unsafe-eval'"]) expect(prod).not.toContain(loose)
    expect(read('packages/desktop/electron.vite.config.ts')).toMatch(/transformIndexHtml[\s\S]*withProductionCsp/)
  })

  // Audit B-4 (C8), red team R2 and R5: the built app's policy is exactly this, and only shrinks.
  // No inline script (an adopted node's onerror= would run beside window.slate), no remote image
  // (a note's <img> would beacon the reader's IP), nothing by default.
  const PROD_PINNED = [
    "default-src 'none'",
    "script-src 'self'",
    "script-src 'wasm-unsafe-eval'",
    "style-src 'self'",
    "style-src 'unsafe-inline'",
    "img-src 'self'",
    'img-src data:',
    'img-src blob:',
    'img-src slate-blob:',
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    'worker-src blob:',
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ]

  it('the production policy grants nothing beyond B-4: no inline script, no remote images, default none', async () => {
    const { PRODUCTION_CSP } = await import('../../packages/desktop/src/shared/csp')
    const prod = sources(PRODUCTION_CSP)
    expect(prod.filter((s) => !PROD_PINNED.includes(s))).toEqual([])
    expect(prod).toContain("default-src 'none'")
    expect(prod.filter((s) => s.startsWith('script-src'))).not.toContain("script-src 'unsafe-inline'")
    expect(prod.filter((s) => s.startsWith('img-src'))).toEqual(["img-src 'self'", 'img-src data:', 'img-src blob:', 'img-src slate-blob:'])
  })

  it('the pinned list itself refuses the loose sources (self-test)', () => {
    for (const loose of ["script-src 'unsafe-inline'", 'img-src https:', 'img-src http:', "default-src 'self'", 'connect-src ws:']) expect(PROD_PINNED).not.toContain(loose)
  })
})

/**
 * C12 N2 (C8, review M2): a packaged release scrubs SLATE_E2E because `isE2EBuild()` compiles to
 * false. Only `dist:e2e` builds in e2e mode, the define is exactly `mode === 'e2e'`, and testHooks.ts
 * compiled with each mode's define answers accordingly.
 */
describe('the e2e build switch (__SLATE_E2E_BUILD__)', () => {
  const desktop = JSON.parse(read('packages/desktop/package.json')) as { scripts: Record<string, string> }
  const root = JSON.parse(read('package.json')) as { scripts: Record<string, string> }

  // Review L-R2: vite's short flag too, and any script that reaches the e2e build by name.
  const E2E_BUILD = /(?:^|\s)(?:-m|--mode)(?:[ =]|$)|\bdist:e2e\b/

  it('only the dist:e2e scripts build in e2e mode or name dist:e2e; the release workflow never does', () => {
    const offenders = (scripts: Record<string, string>) => Object.entries(scripts).filter(([name, cmd]) => name !== 'dist:e2e' && E2E_BUILD.test(cmd)).map(([name]) => name)
    expect(offenders(desktop.scripts)).toEqual([])
    expect(offenders(root.scripts)).toEqual([])
    expect(desktop.scripts['dist:e2e']).toMatch(/electron-vite build --mode e2e /)
    expect(read('.github/workflows/release.yml')).not.toMatch(E2E_BUILD)
  })

  it('the e2e-build matcher sees each spelling (self-test)', () => {
    for (const cmd of ['electron-vite build --mode e2e', 'electron-vite build -m e2e', 'electron-vite build --mode=e2e', 'npm run dist:e2e && electron-builder', 'electron-vite build -m staging']) expect(E2E_BUILD.test(cmd), cmd).toBe(true)
    for (const cmd of ['electron-vite build && electron-builder --linux', 'playwright test --config e2e-packaged/playwright.config.ts']) expect(E2E_BUILD.test(cmd), cmd).toBe(false)
  })

  it("the define is exactly JSON.stringify(mode === 'e2e')", () => {
    expect(read('packages/desktop/electron.vite.config.ts')).toMatch(/define:\s*\{\s*__SLATE_E2E_BUILD__:\s*JSON\.stringify\(mode === 'e2e'\)\s*\}/)
  })

  it('testHooks.ts built for production says it is not an e2e build, and scrubs SLATE_E2E when packaged', async () => {
    const { transformWithOxc } = await import('vite')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { pathToFileURL } = await import('node:url')
    const { default: config } = (await import('../../packages/desktop/electron.vite.config')) as unknown as {
      default: (env: { command: string; mode: string }) => { main: { define: Record<string, string> } }
    }
    const source = read('packages/desktop/src/main/testHooks.ts')
    const built = async (mode: string) => {
      const define = config({ command: 'build', mode }).main.define
      const { code } = await transformWithOxc(source, 'testHooks.ts', { define })
      const file = join(mkdtempSync(join(tmpdir(), 'slate-define-')), `testHooks.${mode}.mjs`)
      writeFileSync(file, code)
      return (await import(pathToFileURL(file).href)) as { isE2EBuild(): boolean; scrubTestHooks(env: Record<string, string>, packaged: boolean, e2e?: boolean): void }
    }
    const release = await built('production')
    expect(release.isE2EBuild()).toBe(false)
    expect((await built('e2e')).isE2EBuild()).toBe(true)
    const env: Record<string, string> = { SLATE_E2E: '1' }
    release.scrubTestHooks(env, true, release.isE2EBuild())
    expect(env).toEqual({})
  })
})

type Fuses = Record<string, boolean>
const STRICT: Fuses = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
}

describe('electron-builder config', () => {
  const config = createRequire(join(ROOT, 'packages/desktop/'))('./electron-builder.cjs') as { asar?: boolean; electronFuses?: Fuses }
  const loosened = allowlist('fuses-loosened')

  it('packs the app into an asar archive', () => {
    expect(config.asar ?? true).toBe(true)
  })

  it('sets every security fuse to its strict value, except the reviewed ones in fuses-loosened.json', () => {
    const fuses = config.electronFuses ?? {}
    const weak = Object.entries(STRICT)
      .filter(([fuse, strict]) => fuses[fuse] !== strict && !(fuse in loosened))
      .map(([fuse, strict]) => `${fuse} is ${String(fuses[fuse])}; set it to ${String(strict)} in packages/desktop/electron-builder.cjs (loosening a fuse needs the maintainer)`)
    expect(weak).toEqual([])
  })

  it('fuses-loosened.json lists only fuses that are still loose', () => {
    const fuses = config.electronFuses ?? {}
    expect(Object.keys(loosened).filter((fuse) => fuses[fuse] === STRICT[fuse])).toEqual([])
  })
})
