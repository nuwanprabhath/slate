import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fipsConfigText, fipsPaths, writeFipsConfig } from './fipsConfig'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('fipsConfig (audit §4.9, B.18)', () => {
  it('puts the provider in <resources>/fips and the config in <userData>/fips', () => {
    expect(fipsPaths('/app/resources', '/home/u/.config/Slate')).toEqual({
      modulesDir: join('/app/resources', 'fips'),
      configFile: join('/home/u/.config/Slate', 'fips', 'openssl-fips.cnf'),
    })
  })

  it('activates only fips + base, includes the module config by absolute path and sets fips=yes', () => {
    const text = fipsConfigText('/app/resources/fips')
    const lines = text.split('\n')
    expect(lines[0]).toBe('config_diagnostics = 1')
    expect(lines).toContain('openssl_conf = openssl_init')
    expect(lines).toContain(`.include "${join('/app/resources/fips', 'fipsmodule.cnf')}"`)
    expect(text).toContain('[provider_sect]\nfips = fips_sect\nbase = base_sect\n')
    expect(text).toContain('[base_sect]\nactivate = 1\n')
    expect(text).toContain('[algorithm_sect]\ndefault_properties = fips=yes\n')
    // The default provider is never named: in the fips-140-3 context only approved algorithms are reachable.
    expect(text).not.toMatch(/^default\s*=/m)
    expect(text).not.toMatch(/default_sect/)
  })

  it('refuses a path that would break out of the .include line', () => {
    expect(() => fipsConfigText('/tmp/evil"\n[openssl_init]')).toThrow(/cannot be written/)
    expect(() => fipsConfigText('/tmp/a\rb')).toThrow(/cannot be written/)
  })

  it('writes the config with mode 0600 inside a 0700 directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'slate-fipscfg-'))
    dirs.push(root)
    const paths = fipsPaths(join(root, 'res'), join(root, 'user'))
    writeFipsConfig(paths)
    expect(readFileSync(paths.configFile, 'utf8')).toBe(fipsConfigText(paths.modulesDir))
    if (process.platform !== 'win32') {
      expect(statSync(paths.configFile).mode & 0o777).toBe(0o600)
      expect(statSync(join(paths.configFile, '..')).mode & 0o777).toBe(0o700)
    }
  })

  it('tightens a config and folder left with wider permissions by an earlier start', () => {
    if (process.platform === 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'slate-fipscfg-'))
    dirs.push(root)
    const paths = fipsPaths(join(root, 'res'), join(root, 'user'))
    mkdirSync(join(paths.configFile, '..'), { recursive: true })
    chmodSync(join(paths.configFile, '..'), 0o755)
    writeFileSync(paths.configFile, 'stale', { mode: 0o644 })
    writeFipsConfig(paths)
    expect(readFileSync(paths.configFile, 'utf8')).toBe(fipsConfigText(paths.modulesDir))
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(paths.configFile, '..')).mode & 0o777).toBe(0o700)
  })
})
