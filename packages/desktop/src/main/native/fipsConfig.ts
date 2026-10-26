// Writes the OpenSSL config that activates the FIPS provider (audit §4.9).
// Regenerated at every start: the resources path differs per install and `.include` needs an absolute path.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FipsPaths {
  /** <resourcesPath>/fips: holds fips.dylib or fips.so and fipsmodule.cnf. */
  modulesDir: string
  /** <userData>/fips/openssl-fips.cnf */
  configFile: string
}

export function fipsPaths(resourcesPath: string, userData: string): FipsPaths {
  return { modulesDir: join(resourcesPath, 'fips'), configFile: join(userData, 'fips', 'openssl-fips.cnf') }
}

export function fipsConfigText(modulesDir: string): string {
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

export function writeFipsConfig(paths: FipsPaths): void {
  const dir = join(paths.configFile, '..')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // `mode` applies only when a file or folder is created; an older one keeps its permissions otherwise.
  chmodSync(dir, 0o700)
  writeFileSync(paths.configFile, fipsConfigText(paths.modulesDir), { mode: 0o600 })
  chmodSync(paths.configFile, 0o600)
}
