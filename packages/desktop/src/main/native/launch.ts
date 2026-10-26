// Where the addon and the FIPS provider live in a packaged app and in a checkout, and the one call
// index.ts makes at launch.
import { join } from 'node:path'
import { loadNative, type SlateNative } from '@slate/native'
import type { CryptoModuleStatus } from '../../shared/api'
import { provideDbModule } from '../db/dbModule'
import { log } from '../log/logger'
import { startCryptoModule } from './cryptoModule'
import { securityEvent } from '../log/securityEvents'

export interface LaunchContext {
  packaged: boolean
  resourcesPath: string
  userData: string
  /** The directory of out/main/index.js. */
  mainDir: string
  platform: string
  arch: string
}

export function cryptoModulePaths(c: LaunchContext) {
  const target = `${c.platform}-${c.arch}`
  return {
    // electron.vite.config.ts copies the addon to out/native; asarUnpack keeps it outside app.asar.
    addonPath: join(c.mainDir, '../native/slate_native.node'),
    // Packaged: extraResources puts packages/native/fips/<target> at <resources>/fips.
    modulesDir: c.packaged ? join(c.resourcesPath, 'fips') : join(c.mainDir, '../../../native/fips', target),
    configFile: join(c.userData, 'fips', 'openssl-fips.cnf'),
    moduleFile: c.platform === 'darwin' ? ('fips.dylib' as const) : ('fips.so' as const),
    target,
  }
}

export class CryptoModuleUnusable extends Error {
  constructor(status: CryptoModuleStatus) {
    super(`The cryptographic module is unusable: ${status.problem ?? 'not in approved mode'}`)
    this.name = 'CryptoModuleUnusable'
  }
}

/**
 * Review M2 / D-2: a packaged build only starts on the approved module. index.ts no longer calls this: the
 * power-up self-test (C6) fails such a start and shows its error screen instead.
 */
export function requireUsable(status: CryptoModuleStatus): void {
  if (status.development) return
  if (status.problem !== null || status.errorState || !status.approvedMode) throw new CryptoModuleUnusable(status)
}

/**
 * Z-10 (audit §4.3): a secure heap that could not be mlock'd (RLIMIT_MEMLOCK too low) still works, and FIPS
 * does not require locking, so the app runs; the log says so as `module.degraded`, and Settings → Security
 * shows "Memory locking is unavailable on this system" (cryptoModuleText.ts).
 */
export function reportDegraded(status: CryptoModuleStatus, warn: (event: string, fields: { secureHeapLocked: boolean }) => void): void {
  if (status.secureHeapLocked === false) securityEvent.moduleDegraded({ secureHeapLocked: false }, { warn })
}

/**
 * Loads, gates, hardens and initialises the module (S-3 steps 1-3). The power-up self-test (steps 4-6) runs
 * next, in vault/selftest/supervisor.ts; until it passed the gated module serves nothing. `watch` sees every
 * module call (selftest/supervisor.ts `watchModule`), so SCC_12 anywhere fails closed.
 */
export function launchCryptoModule(
  c: LaunchContext,
  watch: (native: SlateNative) => SlateNative = (n) => n,
  onDatabaseError?: (e: unknown) => void,
): { native: SlateNative | null; status: CryptoModuleStatus } {
  const p = cryptoModulePaths(c)
  const started = startCryptoModule({
    load: () => loadNative(p.addonPath),
    requireFips: c.packaged,
    gated: true,
    modulesDir: p.modulesDir,
    configFile: p.configFile,
    moduleFile: p.moduleFile,
  })
  const { status } = started
  const native = started.native ? watch(started.native) : null
  // SQLCipher lives in this module (C3): the notes database opens only through it.
  if (native) provideDbModule(() => ({ native, requireFips: c.packaged, ...(onDatabaseError ? { onDatabaseError } : {}) }))
  const summary = { available: status.available, approvedMode: status.approvedMode, problem: status.problem, version: status.version, postMs: status.postMs, libcrypto: status.libcrypto }
  if (status.problem && status.available) log.error('app', 'crypto module', summary)
  else log.info('app', 'crypto module', summary)
  reportDegraded(status, (event, fields) => log.warn('app', event, fields))
  return { native, status }
}
