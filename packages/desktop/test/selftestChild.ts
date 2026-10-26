// T-POST-02/-04 child (audit §6.9 child.ts): one process per corrupted vector, because the module's error state
// is sticky for the process. Starts the module the way the app does (gated, hardened, initialised), runs the POST,
// then tries one more service. Bundled and run by src/main/vault/selftest/post.child.test.ts; prints JSON.
// Usage: selftest-child <addon> <modulesDir> <configFile> <corrupt id | none> <requireFips 0|1>
import { loadNative, nativeErrorCode } from '@slate/native'
import { provideDbModule } from '../src/main/db/dbModule'
import { startCryptoModule } from '../src/main/native/cryptoModule'
import { isKatId, runPost } from '../src/main/vault/selftest/post'

const [addon = '', modulesDir = '', configFile = '', corruptArg = 'none', requireFipsArg = '0'] = process.argv.slice(2)
const { native, status } = startCryptoModule({
  load: () => loadNative(addon),
  requireFips: false,
  gated: true,
  modulesDir,
  configFile,
  moduleFile: process.platform === 'darwin' ? 'fips.dylib' : 'fips.so',
})
if (!native) throw new Error(`no module: ${String(status.problem)}`)
provideDbModule(() => ({ native, requireFips: false }))
const r = await runPost({ native, requireFips: requireFipsArg === '1', corrupt: isKatId(corruptArg) ? corruptArg : null, exclusive: true })
let servicesRefused = false
try {
  native.keyRandom()
} catch (e) {
  servicesRefused = nativeErrorCode(e) === 'SCC_12'
}
process.stdout.write(JSON.stringify({ ok: r.ok, failed: r.failed, ran: r.ran.length, ms: r.ms, errorState: r.module?.errorState ?? false, servicesRefused, fips: r.module?.fipsActive ?? false }))
