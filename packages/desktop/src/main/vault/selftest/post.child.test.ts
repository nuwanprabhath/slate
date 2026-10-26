// T-POST-02 and T-POST-04 (audit §6.2): one child process per corrupted vector, since the error state is sticky.
// The child (test/selftestChild.ts) is bundled here with Vite and run under this runtime (Electron as Node).
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testAddonPath, testHasProvider, testModuleFile, testModulesDir } from '../../db/testModule'
import { KAT_IDS } from './post'

const out = mkdtempSync(join(tmpdir(), 'slate-post-child-'))
const child = join(out, 'selftest-child.mjs')

beforeAll(async () => {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: join(__dirname, '../../../../test/selftestChild.ts'),
      outDir: out,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { external: [/^node:/, 'electron'], output: { entryFileNames: 'selftest-child.mjs', format: 'es' } },
    },
  })
}, 60_000)
afterAll(() => rmSync(out, { recursive: true, force: true }))

function run(corrupt: string, opts: { requireFips?: boolean; provider?: boolean; modulesDir?: string } = {}) {
  const provider = opts.provider ?? testHasProvider
  const modulesDir = opts.modulesDir ?? (provider ? testModulesDir : join(out, 'no-provider'))
  const r = spawnSync(process.execPath, [child, testAddonPath, modulesDir, join(out, `fips-${corrupt}`, 'openssl-fips.cnf'), corrupt, opts.requireFips ? '1' : '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as { ok: boolean; failed: string[]; ran: number; ms: number; errorState: boolean; servicesRefused: boolean; fips: boolean }
}

describe('T-POST-02: each KAT corrupted on its own, in a fresh process', () => {
  it('an intact module passes every KAT in a gated start (and records how long it took)', () => {
    const r = run('none')
    expect(r).toMatchObject({ ok: true, failed: [], ran: KAT_IDS.length, errorState: false, servicesRefused: false })
    // Criterion 3: < 50 ms on CI runners; the budget is 10 s.
    expect(r.ms).toBeLessThan(1000)
  })

  it.each(KAT_IDS.map((id) => [id]))('%s corrupted: fails exactly that KAT, enters the error state and refuses every later service', (id) => {
    const r = run(id)
    expect({ ok: r.ok, failed: r.failed, errorState: r.errorState, servicesRefused: r.servicesRefused }).toEqual({ ok: false, failed: [id], errorState: true, servicesRefused: true })
  })
})

describe('C2 M2: a packaged start whose provider is missing or refused fails closed, never crashes', () => {
  function packagedStart(modulesDir: string) {
    const r = spawnSync(process.execPath, [child, testAddonPath, modulesDir, join(out, 'fips-packaged', 'openssl-fips.cnf'), 'none', '1', 'packaged'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    // A SIGSEGV here was the bug: status() read OpenSSL's secure heap before init had set it up.
    expect(r.signal, r.stderr).toBeNull()
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout) as { ok: boolean; failed: string[]; problem: string | null; state: string; errorState: boolean; ready: boolean }
  }

  it('no provider file: POST-MODULE-LOAD, the error state, and the self-test error screen state', () => {
    const r = packagedStart(join(out, 'no-provider-packaged'))
    expect(r).toMatchObject({ ok: false, failed: ['POST-MODULE-LOAD'], state: 'selftest-failed', errorState: true, ready: false })
    expect(r.problem).toBe('POST-MODULE-LOAD (missing provider)')
  })

  it('a provider file that is not the pinned module: POST-MODULE-STATUS (SCC_15), selftest-failed', () => {
    const dir = join(out, 'wrong-provider-packaged')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, testModuleFile), 'not the module')
    const r = packagedStart(dir)
    expect(r).toMatchObject({ ok: false, failed: ['POST-MODULE-STATUS'], state: 'selftest-failed', errorState: true, ready: false })
    expect(r.problem).toBe('POST-MODULE-STATUS (SCC_15)')
  })
})

describe('T-POST-04: a start that requires the FIPS provider', () => {
  it('fails POST-MODULE-STATUS on a module without it (the development build), and serves nothing after', () => {
    const r = run('none', { requireFips: true, provider: false })
    expect(r.fips).toBe(false)
    expect(r.failed).toContain('POST-MODULE-STATUS')
    expect(r).toMatchObject({ ok: false, errorState: true, servicesRefused: true })
  })
})

describe('T-POST-05: requireFips with the provider binary one byte flipped', () => {
  it('fails POST-MODULE-STATUS: the pinned digest refuses the file before OpenSSL loads it, and nothing is served after', () => {
    const dir = join(out, 'flipped-provider')
    // The built provider when this checkout has one; otherwise stand-in bytes in its place, which the
    // compiled-in pin refuses the same way (the addon hashes whatever file sits there).
    if (testHasProvider) cpSync(testModulesDir, dir, { recursive: true })
    else {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, testModuleFile), Buffer.alloc(64 * 1024, 0x5a))
    }
    const file = join(dir, testModuleFile)
    const bytes = readFileSync(file)
    bytes[bytes.length >> 1]! ^= 0x01
    writeFileSync(file, bytes)
    const r = run('none', { requireFips: true, modulesDir: dir })
    expect(r.failed).toContain('POST-MODULE-STATUS')
    expect(r).toMatchObject({ ok: false, fips: false, errorState: true, servicesRefused: true })
  })
})
