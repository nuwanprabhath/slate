import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CryptoModuleStatus } from '../../shared/api'
import { CryptoModuleUnusable, cryptoModulePaths, reportDegraded, requireUsable } from './launch'

describe('cryptoModulePaths', () => {
  it('packaged: the provider sits in <resources>/fips (extraResources) and the addon beside out/main', () => {
    const p = cryptoModulePaths({ packaged: true, resourcesPath: '/Applications/Slate.app/Contents/Resources', userData: '/u', mainDir: '/Applications/Slate.app/Contents/Resources/app.asar/out/main', platform: 'darwin', arch: 'arm64' })
    expect(p).toEqual({
      addonPath: join('/Applications/Slate.app/Contents/Resources/app.asar/out/main', '../native/slate_native.node'),
      modulesDir: join('/Applications/Slate.app/Contents/Resources', 'fips'),
      configFile: join('/u', 'fips', 'openssl-fips.cnf'),
      moduleFile: 'fips.dylib',
      target: 'darwin-arm64',
    })
  })

  it('from a checkout: the provider build in packages/native/fips/<platform>-<arch>', () => {
    const p = cryptoModulePaths({ packaged: false, resourcesPath: '/x', userData: '/u', mainDir: '/repo/packages/desktop/out/main', platform: 'linux', arch: 'x64' })
    expect(p.modulesDir).toBe(join('/repo/packages/native/fips/linux-x64'))
    expect(p.moduleFile).toBe('fips.so')
    expect(p.addonPath).toBe(join('/repo/packages/desktop/out/native/slate_native.node'))
  })
})

describe('requireUsable (review M2: a packaged build never runs without its approved module)', () => {
  const base: CryptoModuleStatus = {
    available: true, problem: null, module: 'OpenSSL FIPS Provider', version: '3.1.2', cmvp: 4985, standard: 'FIPS 140-3',
    certificateUrl: 'https://csrc.nist.gov/', approvedMode: true, errorState: false, postMs: 5, libcrypto: 'OpenSSL 3.5.9', secureHeapLocked: true, development: false,
  }

  it('lets an approved-mode packaged build start', () => {
    expect(() => requireUsable(base)).not.toThrow()
  })

  it('stops a packaged build that failed its start-up checks or is not in approved mode', () => {
    expect(() => requireUsable({ ...base, approvedMode: false, errorState: true, problem: 'POST-MODULE-LOAD (missing provider)' })).toThrow(CryptoModuleUnusable)
    expect(() => requireUsable({ ...base, approvedMode: false })).toThrow(/approved mode/)
  })

  it('lets a development build start without the module', () => {
    expect(() => requireUsable({ ...base, development: true, available: false, approvedMode: false, problem: 'The cryptographic module is not available in this build.' })).not.toThrow()
  })

  it('Z-10 (C7): a secure heap that is not mlock\'d is logged as module.degraded, and only then', () => {
    const events: string[] = []
    const base = { available: true, problem: null, module: 'm', version: 'v', cmvp: 1, standard: 's', certificateUrl: 'u', approvedMode: true, errorState: false, postMs: 1, libcrypto: 'l', development: false }
    reportDegraded({ ...base, secureHeapLocked: false }, (e) => events.push(e))
    reportDegraded({ ...base, secureHeapLocked: true }, (e) => events.push(e))
    reportDegraded({ ...base, secureHeapLocked: null }, (e) => events.push(e))
    expect(events).toEqual(['module.degraded'])
  })
})
