// Release smoke check (review R1): run the PACKAGED app binary as Node (ELECTRON_RUN_AS_NODE, the
// runAsNode fuse is on for slate-mcp) and start the shipped slate_native.node on the shipped
// resources/fips, exactly as the app does at launch. Under a Developer ID build this runs inside the
// signed, hardened-runtime binary, so a provider that signing rewrote (pin mismatch, SCC_15) or that
// library validation refuses (SCC_6) fails the release before it is published.
//
// Usage: ELECTRON_RUN_AS_NODE=1 <packaged executable> smoke-native.cjs <resources dir>
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

/** Must equal fipsConfigText in src/main/native/fipsConfig.ts (packaging.test.ts checks it). */
function configText(modulesDir) {
  const include = join(modulesDir, 'fipsmodule.cnf')
  if (/["\n\r]/.test(include)) throw new Error('The FIPS module path cannot be written into an OpenSSL config')
  return [
    'config_diagnostics = 1',
    'openssl_conf = openssl_init',
    '',
    `.include "${include}"`,
    '',
    '[openssl_init]',
    'providers = provider_sect',
    'alg_section = algorithm_sect',
    '',
    '[provider_sect]',
    'fips = fips_sect',
    'base = base_sect',
    '',
    '[base_sect]',
    'activate = 1',
    '',
    '[algorithm_sect]',
    'default_properties = fips=yes',
    '',
  ].join('\n')
}

function main(resources) {
  const modulesDir = join(resources, 'fips')
  const native = require(join(resources, 'app.asar.unpacked', 'out', 'native', 'slate_native.node'))
  const tmp = mkdtempSync(join(tmpdir(), 'slate-smoke-'))
  try {
    const config = join(tmp, 'openssl-fips.cnf')
    writeFileSync(config, configText(modulesDir), { mode: 0o600 })
    native.init(config, modulesDir, true)
    const aad = new TextEncoder().encode('slate/release/smoke')
    // A fresh master key wrapped under a PBKDF2 KEK and unwrapped; KBKDF subkeys of both handles must agree
    // (a data key wraps no key since review C4 M1, so the probe goes through a derivation).
    const kek = native.pbkdf2(native.randomBytes(32), native.randomBytes(16), 1000)
    const key = native.keyRandom('master')
    const wrapped = native.gcmSealKey(kek, key, null, aad)
    const back = native.gcmOpenKey(kek, wrapped.subarray(0, 12), aad, wrapped.subarray(12))
    const context = native.randomBytes(16)
    const a = native.kbkdf(key, 'slate/release/smoke', context)
    const b = native.kbkdf(back, 'slate/release/smoke', context)
    const probe = native.randomBytes(32)
    const sealed = native.gcmSeal(b, null, aad, probe)
    const opened = native.gcmOpen(a, sealed.subarray(0, 12), aad, sealed.subarray(12))
    const roundTrip = opened.length === probe.length && opened.every((b, i) => b === probe[i])
    const s = native.status()
    const result = {
      approvedMode: s.fipsActive && !s.errorState,
      providers: s.defaultContextProviders.split(',').sort().join(','),
      module: s.fipsModule,
      libcrypto: s.libcrypto,
      roundTrip,
    }
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.approvedMode || result.providers !== 'base,fips' || !roundTrip) {
      process.stderr.write('smoke-native: the packaged module is not in approved mode\n')
      process.exitCode = 1
    }
  } catch (e) {
    process.stderr.write(`smoke-native: ${e && e.code ? e.code + ' ' : ''}${e && e.message}\n`)
    process.exitCode = 1
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// resolve(): require() treats a relative path without ./ as a package name.
if (require.main === module) main(resolve(process.argv[2] ?? '.'))

module.exports = { configText }
