// The real slate_native.node for main-process tests (testSetup.ts registers it): started exactly as
// the app starts it, on the FIPS provider when this checkout has built one.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadNative, type KeyHandle } from '@slate/native'
import { startCryptoModule } from '../native/cryptoModule'
import { dbModule, type DbModule } from './dbModule'

const target = `${process.platform}-${process.arch}`
const nativeDir = join(__dirname, '../../../../native')
export const testAddonPath = join(nativeDir, 'prebuilds', target, 'slate_native.node')
export const testModulesDir = join(nativeDir, 'fips', target)
export const testModuleFile = process.platform === 'darwin' ? ('fips.dylib' as const) : ('fips.so' as const)
export const testHasProvider = existsSync(join(testModulesDir, testModuleFile))

export function startTestDbModule(): DbModule {
  if (!existsSync(testAddonPath)) throw new Error(`${testAddonPath} is missing: run \`npm run -w @slate/native build\` before the main-process tests`)
  const { native, status } = startCryptoModule({
    load: () => loadNative(testAddonPath),
    requireFips: testHasProvider,
    modulesDir: testModulesDir,
    configFile: join(mkdtempSync(join(tmpdir(), 'slate-testfips-')), 'fips', 'openssl-fips.cnf'),
    moduleFile: testModuleFile,
  })
  if (!native || status.problem) throw new Error(`The test cryptographic module did not start: ${status.problem}`)
  return { native, requireFips: testHasProvider }
}

/** A fresh random 32-byte database key, held by the module. */
export function testKey(): KeyHandle {
  return dbModule().native.keyRandom('db')
}
