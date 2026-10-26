// T-POST-02/-04 child (audit §6.9 child.ts): one process per corrupted vector, because the module's error state
// is sticky for the process. Starts the module the way the app does (gated, hardened, initialised), runs the POST,
// then tries one more service. Bundled and run by src/main/vault/selftest/post.child.test.ts; prints JSON.
// Usage: selftest-child <addon> <modulesDir> <configFile> <corrupt id | none> <requireFips 0|1> [packaged]
// `packaged` starts as a packaged build does (requireFips from the start) and runs the app's startupSelfTest,
// printing the vault state it ends in (C2 M2: a missing or refused provider ends in `selftest-failed`).
import { loadNative, nativeErrorCode } from '@slate/native'
import { provideDbModule } from '../src/main/db/dbModule'
import { startCryptoModule } from '../src/main/native/cryptoModule'
import { isKatId, runPost } from '../src/main/vault/selftest/post'
import { startupSelfTest } from '../src/main/vault/selftest/supervisor'
import { VaultStateMachine } from '../src/main/vault/vaultState'

const [addon = '', modulesDir = '', configFile = '', corruptArg = 'none', requireFipsArg = '0', startArg = ''] = process.argv.slice(2)
const packaged = startArg === 'packaged'
const { native, status } = startCryptoModule({
  load: () => loadNative(addon),
  requireFips: packaged,
  gated: true,
  modulesDir,
  configFile,
  moduleFile: process.platform === 'darwin' ? 'fips.dylib' : 'fips.so',
})
if (!native) throw new Error(`no module: ${String(status.problem)}`)
if (packaged) {
  const vault = new VaultStateMachine()
  const quiet = () => {}
  const r = await startupSelfTest({ native, startProblem: status.problem, requireFips: () => true, vault, initialState: () => 'locked', corrupt: null, passed: quiet, failed: quiet })
  const s = native.status()
  process.stdout.write(JSON.stringify({ ok: r.ok, failed: r.failed, problem: status.problem, state: vault.state, errorState: s.errorState, ready: s.ready }))
  process.exit(0)
}
provideDbModule(() => ({ native, requireFips: false }))
const r = await runPost({ native, requireFips: requireFipsArg === '1', corrupt: isKatId(corruptArg) ? corruptArg : null, exclusive: true })
let servicesRefused = false
try {
  native.keyRandom()
} catch (e) {
  servicesRefused = nativeErrorCode(e) === 'SCC_12'
}
process.stdout.write(JSON.stringify({ ok: r.ok, failed: r.failed, ran: r.ran.length, ms: r.ms, errorState: r.module?.errorState ?? false, servicesRefused, fips: r.module?.fipsActive ?? false }))
