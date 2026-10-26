import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkExports,
  configureTarget,
  DigestMismatch,
  exportedSymbols,
  forbiddenStrings,
  buildKind,
  checkPin,
  buildEnv,
  pinHeader,
  fipsModuleFile,
  hostTarget,
  parsePublishedSha256,
  REQUIRED_EXPORTS,
  verifyTarball,
  patchSqlcipher,
  patchOpensslArgon2,
} from '../scripts/lib.mjs'
import lock from '../deps.lock.json'
import sbomComponents from '../sbom-components.json'
import pins from '../fips-digest.json'
import cryptoModule from '../../../docs/compliance/crypto-module.json'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function tempFile(bytes: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-native-'))
  dirs.push(dir)
  const file = join(dir, 'x.tar.gz')
  writeFileSync(file, bytes)
  return file
}

describe('tarball pinning (deps.lock.json)', () => {
  // sha256("abc")
  const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

  it('accepts a tarball whose SHA-256 equals the pin', () => {
    expect(() => verifyTarball(tempFile('abc'), ABC)).not.toThrow()
  })

  it('refuses a tarball whose SHA-256 differs from the pin', () => {
    expect(() => verifyTarball(tempFile('abd'), ABC)).toThrow(DigestMismatch)
  })

  it('refuses an empty or malformed pin instead of skipping the check', () => {
    expect(() => verifyTarball(tempFile('abc'), '')).toThrow(DigestMismatch)
    expect(() => verifyTarball(tempFile('abc'), ABC.toUpperCase().slice(1))).toThrow(DigestMismatch)
  })

  it('reads the .sha256 files OpenSSL publishes in both of their formats', () => {
    expect(parsePublishedSha256(`${ABC} *openssl-3.5.9.tar.gz\n`)).toBe(ABC)
    expect(parsePublishedSha256(` ${ABC}\n`)).toBe(ABC)
    expect(() => parsePublishedSha256('not a digest')).toThrow()
  })

  it('pins OpenSSL 3.5.x as libcrypto and the CMVP #4985 provider source 3.1.2', () => {
    expect(lock.openssl.version).toMatch(/^3\.5\.\d+$/)
    expect(lock.fipsProvider.version).toBe('3.1.2')
    expect(lock.fipsProvider.cmvp).toBe(4985)
    for (const dep of [lock.openssl, lock.fipsProvider]) {
      expect(dep.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(dep.url).toMatch(/^https:\/\/github\.com\/openssl\/openssl\/releases\/download\//)
      expect(dep.sha256Url).toBe(`${dep.url}.sha256`)
    }
  })
})

describe('docs/compliance/crypto-module.json (criterion 6)', () => {
  it('names the module that deps.lock.json actually builds', () => {
    expect(cryptoModule).toMatchObject({ module: 'OpenSSL FIPS Provider', standard: 'FIPS 140-3', sunset: '2030-03-10' })
    expect(cryptoModule.version).toBe(lock.fipsProvider.version)
    expect(cryptoModule.cmvp).toBe(lock.fipsProvider.cmvp)
    expect(cryptoModule.libcrypto).toBe(lock.openssl.version)
    expect(cryptoModule.securityPolicyUrl).toMatch(/^https:\/\/csrc\.nist\.gov\/.*4985/)
    expect(cryptoModule.entropyCaveat.length).toBeGreaterThan(20)
  })
})

describe('targets', () => {
  it('maps each prebuild target to its OpenSSL Configure target', () => {
    expect(configureTarget('darwin-arm64')).toBe('darwin64-arm64-cc')
    expect(configureTarget('darwin-x64')).toBe('darwin64-x86_64-cc')
    expect(configureTarget('linux-x64')).toBe('linux-x86_64')
    expect(() => configureTarget('win32-x64')).toThrow()
  })

  it('names the host target and the provider file per platform', () => {
    expect(hostTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(hostTarget('linux', 'x64')).toBe('linux-x64')
    expect(fipsModuleFile('darwin-arm64')).toBe('fips.dylib')
    expect(fipsModuleFile('linux-x64')).toBe('fips.so')
  })
})

describe('symbol-export check (criterion 1)', () => {
  const macGood = ['0000000000001234 T _napi_register_module_v1', '0000000000001240 T _node_api_module_get_api_version_v1'].join('\n')
  const linuxGood = ['0000000000011a0 T napi_register_module_v1', '0000000000011b0 T node_api_module_get_api_version_v1'].join('\n')

  it('accepts exactly the two N-API entry points', () => {
    expect(checkExports(exportedSymbols(macGood, 'darwin'))).toEqual({ ok: true, extra: [], missing: [] })
    expect(checkExports(exportedSymbols(linuxGood, 'linux'))).toEqual({ ok: true, extra: [], missing: [] })
    expect([...REQUIRED_EXPORTS].sort()).toEqual(['napi_register_module_v1', 'node_api_module_get_api_version_v1'])
  })

  it('fails when libcrypto or the core leaks a symbol', () => {
    const leaked = `${macGood}\n0000000000002000 T _EVP_EncryptInit_ex2\n0000000000003000 D _scc_init_data\n0000000000004000 T _scc_key_random`
    expect(checkExports(exportedSymbols(leaked, 'darwin'))).toEqual({ ok: false, extra: ['EVP_EncryptInit_ex2', 'scc_init_data', 'scc_key_random'], missing: [] })
  })

  it('fails when an entry point is missing', () => {
    const r = checkExports(exportedSymbols('0000000000011a0 T napi_register_module_v1', 'linux'))
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['node_api_module_get_api_version_v1'])
  })

  it('ignores undefined references and blank lines', () => {
    const withUndefined = `${linuxGood}\n                 U napi_create_object\n\n                 w __gmon_start__`
    expect(checkExports(exportedSymbols(withUndefined, 'linux')).ok).toBe(true)
  })
})

describe('test-only code is absent from a release addon (review M3)', () => {
  it('finds keyImport and the KAT hooks in a binary that contains them', () => {
    const bin = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('keyImport\0'), Buffer.from('scc__slot_bytes_for_kat\0')])
    expect(forbiddenStrings(bin)).toEqual(['keyImport', 'scc__slot_bytes_for_kat'])
  })

  it('passes a binary without them', () => {
    expect(forbiddenStrings(Buffer.from('napi_register_module_v1\0keyRandom\0gcmSealKey\0'))).toEqual([])
  })
})

describe('the provider pin is an input, never regenerated silently (review M4, R3)', () => {
  const A = { provider: 'a'.repeat(64), config: 'c'.repeat(64) }
  const B = { provider: 'b'.repeat(64), config: 'c'.repeat(64) }
  const C = { provider: 'a'.repeat(64), config: 'd'.repeat(64) }

  it('accepts a provider and fipsmodule.cnf that match the committed pin', () => {
    expect(checkPin('darwin-arm64', A, { 'darwin-arm64': A }, false)).toEqual({ 'darwin-arm64': A })
  })

  it('refuses a provider or a fipsmodule.cnf that differs from, or has no, committed pin', () => {
    expect(() => checkPin('darwin-arm64', B, { 'darwin-arm64': A }, false)).toThrow(/differs from the committed pin/)
    expect(() => checkPin('darwin-arm64', C, { 'darwin-arm64': A }, false)).toThrow(/differs from the committed pin/)
    expect(() => checkPin('linux-x64', B, { 'darwin-arm64': A }, false)).toThrow(/no committed pin/)
  })

  it('changes the pin only when asked to (--update-pin)', () => {
    expect(checkPin('linux-x64', B, { 'darwin-arm64': A }, true)).toEqual({ 'darwin-arm64': A, 'linux-x64': B })
  })

  it('compiles both pins into the addon as C strings, and an absent pin as empty (init then fails)', () => {
    expect(pinHeader(A)).toContain(`#define SLATE_FIPS_SHA256 "${A.provider}"`)
    expect(pinHeader(A)).toContain(`#define SLATE_FIPS_CNF_SHA256 "${A.config}"`)
    expect(pinHeader(undefined)).toContain('#define SLATE_FIPS_SHA256 ""')
    expect(pinHeader(undefined)).toContain('#define SLATE_FIPS_CNF_SHA256 ""')
    expect(() => pinHeader({ provider: 'not hex"', config: A.config })).toThrow()
    expect(() => pinHeader({ provider: A.provider, config: 'x' })).toThrow()
  })

  it('the committed pins have the provider and config digests for each target', () => {
    for (const [target, pin] of Object.entries(pins as Record<string, { provider: string; config: string }>)) {
      expect(pin.provider, target).toMatch(/^[0-9a-f]{64}$/)
      expect(pin.config, target).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('the provider is built from a clean environment, per its Security Policy (review L5)', () => {
  const caller = { PATH: '/usr/bin:/bin', HOME: '/home/u', TMPDIR: '/tmp/x', CC: 'evil-cc', CFLAGS: '-O0 -DFIPS_BYPASS', CPPFLAGS: '-I/evil', LDFLAGS: '-L/evil', MAKEFLAGS: 'CC=evil', OPENSSL_CONF: '/evil.cnf', PERL5LIB: '/evil', MACOSX_DEPLOYMENT_TARGET: '9.0' }

  it('passes only PATH, HOME and TMPDIR, plus the pinned macOS deployment target', () => {
    expect(buildEnv(caller, 'darwin-arm64')).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/u', TMPDIR: '/tmp/x', MACOSX_DEPLOYMENT_TARGET: '12.0' })
    expect(buildEnv(caller, 'linux-x64')).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/u', TMPDIR: '/tmp/x' })
  })

  it('drops a variable that is missing instead of setting it to undefined', () => {
    expect(buildEnv({ PATH: '/bin' }, 'linux-x64')).toEqual({ PATH: '/bin' })
  })
})

describe('the addon is built from a clean environment too (re-review note)', () => {
  it('build-addon.mjs runs node-gyp with buildEnv(), so CFLAGS/CPPFLAGS/LDFLAGS cannot reach it', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', 'build-addon.mjs'), 'utf8')
    const call = /execFileSync\(process\.execPath, \[nodeGyp[^\n]*\)/.exec(src)?.[0] ?? ''
    expect(call).toMatch(/env: buildEnv\(process\.env, target\)/)
  })
})

describe('a KAT build can never pass for a release (re-review note)', () => {
  it('reads the build-kind marker the core compiles in, which strip cannot remove', () => {
    expect(buildKind(Buffer.from('\0slate-native-build:release\0'))).toBe('release')
    expect(buildKind(Buffer.from('\0slate-native-build:kat\0'))).toBe('kat')
    expect(buildKind(Buffer.from('\0napi_register_module_v1\0'))).toBeNull()
    expect(buildKind(Buffer.from('slate-native-build:release slate-native-build:kat'))).toBe('kat')
  })

  it('lists every KAT-only hook as a forbidden name', () => {
    const bin = Buffer.from('scc__set_generation_for_kat scc__force_provider_error_for_kat')
    expect(forbiddenStrings(bin)).toEqual(['scc__set_generation_for_kat', 'scc__force_provider_error_for_kat'])
  })

  it('the sources refuse to compile a KAT binding or a KAT core in a release build', () => {
    const binding = readFileSync(join(__dirname, '..', 'src', 'binding.c'), 'utf8')
    const core = readFileSync(join(__dirname, '..', 'src', 'slate_crypto_core.c'), 'utf8')
    const gyp = readFileSync(join(__dirname, '..', 'binding.gyp'), 'utf8')
    expect(binding).toMatch(/#ifdef SCC_KAT_BUILD\n#error /)
    expect(core).toMatch(/#if defined\(SCC_KAT_BUILD\) && defined\(SCC_RELEASE\)\n#error /)
    expect(gyp).toMatch(/"SCC_RELEASE"/)
  })
})

describe('SQLCipher (audit C3, §4.9)', () => {
  const STUB = 'static int sqlcipher_openssl_fips_status(void *ctx) {\n  return 0;\n}\n'
  const INCLUDE = '#include <openssl/err.h> /* amalgamator: dontcache */\n'

  it('pins a community SQLCipher 4.x release tarball and the patched amalgamation by SHA-256', () => {
    expect(lock.sqlcipher.version).toMatch(/^4\.\d+\.\d+$/)
    expect(lock.sqlcipher.url).toBe(`https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v${lock.sqlcipher.version}.tar.gz`)
    expect(lock.sqlcipher.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(lock.sqlcipher.amalgamationSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sbom-components.json lists what deps.lock.json builds, with the same digests', () => {
    const byName = Object.fromEntries(sbomComponents.map((c) => [c.name, c]))
    for (const [name, dep] of [['openssl', lock.openssl], ['openssl-fips-provider', lock.fipsProvider], ['sqlcipher', lock.sqlcipher]] as const) {
      expect(byName[name]?.version, name).toBe(dep.version)
      expect(byName[name]?.hashes[0]?.content, name).toBe(dep.sha256)
    }
    expect(byName['better-sqlite3-multiple-ciphers']?.version).toBe('13.0.3')
  })

  it('every addon target, vendored ones included, links for macOS 12 like libcrypto (no ld version warnings)', () => {
    const gyp = readFileSync(join(__dirname, '..', 'binding.gyp'), 'utf8')
    const targets = gyp.split('"target_name": ').slice(1)
    expect(targets).toHaveLength(3)
    for (const t of targets) expect(t, t.slice(0, 20)).toMatch(/"MACOSX_DEPLOYMENT_TARGET": "12\.0"/)
  })

  it('makes PRAGMA cipher_fips_status report the default context instead of a constant 0', () => {
    const out = patchSqlcipher(`a\n${INCLUDE}b\n${STUB}c\n`)
    expect(out).not.toContain(STUB)
    expect(out).toContain('return EVP_default_properties_is_fips_enabled(NULL) && OSSL_PROVIDER_available(NULL, "fips");')
    expect(out).toContain(`${INCLUDE}#include <openssl/provider.h>`)
  })

  it('refuses a source where an anchor is missing or appears twice, instead of shipping it unpatched', () => {
    expect(() => patchSqlcipher(`${INCLUDE}x\n`)).toThrow(/cipher_fips_status.*found 0/)
    expect(() => patchSqlcipher(`${STUB}`)).toThrow(/provider\.h.*found 0/)
    expect(() => patchSqlcipher(`${INCLUDE}${STUB}${STUB}`)).toThrow(/found 2/)
  })
})

describe('C4: the OpenSSL Argon2id patch (a real-cost derivation must fit outside the 1 MiB secure heap)', () => {
  const ALLOC = [
    '    if (ctx->type != ARGON2_D)',
    '        ctx->memory = OPENSSL_secure_zalloc(ctx->memory_blocks * sizeof(BLOCK));',
    '    else',
    '        ctx->memory = OPENSSL_zalloc(ctx->memory_blocks * sizeof(BLOCK));',
    '',
  ].join('\n')

  it('falls back to ordinary memory when the secure heap cannot hold the matrix, and keeps the error queue clean', () => {
    const out = patchOpensslArgon2(`a\n${ALLOC}b\n`)
    expect(out).not.toContain(ALLOC)
    expect(out).toMatch(/ERR_set_mark\(\);[\s\S]*OPENSSL_secure_zalloc[\s\S]*if \(ctx->memory == NULL\) \{\n        ERR_pop_to_mark\(\);\n        ctx->memory = OPENSSL_zalloc/)
    expect(out).toContain('ERR_clear_last_mark();')
  })

  it('refuses a source where the allocation is missing or appears twice', () => {
    expect(() => patchOpensslArgon2('nothing here')).toThrow(/found 0/)
    expect(() => patchOpensslArgon2(ALLOC + ALLOC)).toThrow(/found 2/)
  })

  it('build-openssl applies it to libcrypto (not to the FIPS provider, whose pin stays)', () => {
    const script = readFileSync(join(__dirname, '..', 'scripts', 'build-openssl.mjs'), 'utf8')
    expect(script).toMatch(/patchOpensslArgon2\(/)
    const fips = script.slice(script.indexOf('async function buildFipsProvider'))
    expect(fips).not.toMatch(/patchOpensslArgon2/)
  })
})
