import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The electron-builder configuration decides the release fuses and signing (audit B-6, C12, D-1).
const desktop = join(__dirname, '..', '..')
const require = createRequire(join(desktop, 'package.json'))
const SIGNING_VARS = ['CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']

type Config = { electronFuses: Record<string, boolean>; mac: Record<string, unknown> }

/** Loads a config afresh under `env`, as electron-builder would in a process with that environment. */
function load(file: string, env: Record<string, string> = {}): Config {
  const saved = Object.fromEntries(SIGNING_VARS.map((k) => [k, process.env[k]]))
  for (const k of SIGNING_VARS) delete process.env[k]
  Object.assign(process.env, env)
  try {
    for (const f of ['electron-builder.cjs', 'electron-builder.e2e.cjs']) delete require.cache[require.resolve(join(desktop, f))]
    return require(join(desktop, file)) as Config
  } finally {
    for (const k of SIGNING_VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

afterEach(() => {
  for (const f of ['electron-builder.cjs', 'electron-builder.e2e.cjs']) delete require.cache[require.resolve(join(desktop, f))]
})

describe('release configuration (C12)', () => {
  it('T-B-07: release fuses refuse --inspect and give file:// no extra privileges', () => {
    const fuses = load('electron-builder.cjs').electronFuses
    expect(fuses).toMatchObject({
      enableNodeCliInspectArguments: false,
      grantFileProtocolExtraPrivileges: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      resetAdHocDarwinSignature: true,
    })
    // POA&M: stays on while slate-mcp runs the app binary as Node (no SEA yet; see docs/compliance/poam.md).
    expect(fuses.runAsNode).toBe(true)
  })

  it('the e2e-packaged build differs from a release only in allowing --inspect', () => {
    const release = load('electron-builder.cjs')
    const e2e = load('electron-builder.e2e.cjs')
    expect(e2e.electronFuses).toEqual({ ...release.electronFuses, enableNodeCliInspectArguments: true })
    expect({ ...e2e, electronFuses: null }).toEqual({ ...release, electronFuses: null })
  })

  it('D-1: without signing secrets the mac build is ad-hoc signed and not notarised', () => {
    const { mac } = load('electron-builder.cjs')
    expect(mac).toMatchObject({ identity: null, hardenedRuntime: false, notarize: false })
  })

  it('D-1: with a certificate and Apple credentials it signs with the hardened runtime and notarises', () => {
    const { mac } = load('electron-builder.cjs', { CSC_LINK: 'base64-p12', CSC_KEY_PASSWORD: 'x', APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' })
    expect(mac.identity).toBeUndefined()
    expect(mac).toMatchObject({ hardenedRuntime: true, notarize: true, entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' })
    // A certificate alone signs but cannot notarise.
    expect(load('electron-builder.cjs', { CSC_LINK: 'base64-p12' }).mac).toMatchObject({ hardenedRuntime: true, notarize: false })
  })

  it('the entitlements never allow a debugger to attach', () => {
    const plist = join(desktop, 'build', 'entitlements.mac.plist')
    expect(existsSync(plist)).toBe(true)
    const text = readFileSync(plist, 'utf8')
    expect(text).not.toMatch(/get-task-allow/)
    // Review F4: exactly this set; each extra entitlement weakens the hardened runtime.
    const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])
    expect(keys).toEqual(['com.apple.security.cs.allow-jit'])
  })

  it('T-B-07 guard: check-fuses.mjs fails on a binary whose fuses are not the release ones', () => {
    // The stock Electron this suite runs on has every fuse at its default.
    const exe = process.execPath
    const app = process.platform === 'darwin' ? exe.slice(0, exe.indexOf('.app') + 4) : exe
    const out = spawnSync(process.execPath, [join(desktop, '..', '..', 'scripts', 'check-fuses.mjs'), app, join(desktop, 'electron-builder.cjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    })
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/GrantFileProtocolExtraPrivileges is true, the config says false/)
    expect(out.stderr).toMatch(/EnableNodeCliInspectArguments is true, the config says false/)
  })

  it('the SBOM hook adds native components with versions and hashes, and refuses one without a hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-sbom-'))
    try {
      const sbom = join(dir, 'slate-sbom.cdx.json')
      writeFileSync(sbom, JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [{ name: 'loro-crdt', version: '1.16.4', 'bom-ref': 'x' }] }))
      const native = join(dir, 'native.json')
      writeFileSync(native, JSON.stringify([{ name: 'openssl', version: '3.5.4', hashes: [{ alg: 'SHA-256', content: 'ab' }] }]))
      const script = join(desktop, '..', '..', 'scripts', 'sbom-add-native.mjs')
      const run = (input: string) => spawnSync(process.execPath, [script, sbom, input], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
      expect(run(native).status).toBe(0)
      const names = (JSON.parse(readFileSync(sbom, 'utf8')) as { components: Array<{ name: string }> }).components.map((c) => c.name)
      expect(names).toEqual(['loro-crdt', 'openssl'])
      writeFileSync(native, JSON.stringify([{ name: 'sqlcipher', version: '4.6.1' }]))
      expect(run(native).status).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('review F3: no job that reads the update signing key runs npm or npx', () => {
    const yml = readFileSync(join(desktop, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
    const jobs = yml.slice(yml.indexOf('\njobs:\n')).split(/\n(?=  [A-Za-z][\w-]*:\n)/).slice(1)
    const signing = jobs.filter((j) => j.includes('secrets.SLATE_UPDATE_SIGNING_KEY'))
    expect(signing).toHaveLength(1)
    // A package script or a transitive dependency in the same job could rewrite dist/ or the signer.
    const code = signing[0]!
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && !/^\s*cache:/.test(l))
      .join('\n')
    expect(code).not.toMatch(/\b(npx|npm)\b/)
  })
  it('the signing key is read only by jobs in the release environment, which only v* tags can deploy to', () => {
    const yml = readFileSync(join(desktop, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
    const jobs = yml.slice(yml.indexOf('\njobs:\n')).split(/\n(?=  [A-Za-z][\w-]*:\n)/).slice(1)
    const signing = jobs.filter((j) => j.includes('secrets.SLATE_UPDATE_SIGNING_KEY'))
    expect(signing.length).toBeGreaterThan(0)
    // As a repository secret the key would reach any job of any workflow; as an environment secret only these.
    for (const job of signing) expect(job).toMatch(/\n    environment: release\n/)
  })
  it('review R1: the signing job downloads only release-* into dist/, and the SBOM artefact by name elsewhere', () => {
    const yml = readFileSync(join(desktop, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
    const job = yml.slice(yml.indexOf('\njobs:\n')).split(/\n(?=  [A-Za-z][\w-]*:\n)/).find((j) => j.includes('secrets.SLATE_UPDATE_SIGNING_KEY'))!
    const downloads = job.split(/\n(?=      - )/).filter((step) => step.includes('actions/download-artifact@'))
    expect(downloads.length).toBeGreaterThan(0)
    for (const step of downloads) {
      const pattern = /\n\s+pattern:\s*(\S+)/.exec(step)?.[1]
      const name = /\n\s+name:\s*(\S+)/.exec(step)?.[1]
      const path = /\n\s+path:\s*(\S+)/.exec(step)?.[1]
      // An unfiltered download unpacks every artefact of the run, the SBOM job's included, where the signer signs.
      expect(pattern ?? name, step).toBeDefined()
      if (path === 'dist') expect(pattern ?? name).toBe('release-*')
      if (name === 'sbom' || pattern === 'sbom') expect(path).not.toBe('dist')
    }
    expect(downloads.some((d) => /name:\s*sbom\b/.test(d))).toBe(true)
  })
})
