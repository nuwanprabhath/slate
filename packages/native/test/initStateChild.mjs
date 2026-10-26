// Child process for initState.test.ts (audit §4.2, C2 M2, C6): the read-only services must be safe in every
// init state. A crash here (SIGSEGV) is what the test catches, so each scenario runs in its own process.
// Usage: node initStateChild.mjs <fresh|missing|wrongPin|errorBeforeInit>
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const native = createRequire(import.meta.url)(join(import.meta.dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node'))
const mode = process.argv[2]
const code = (fn) => {
  try {
    fn()
    return 'ran'
  } catch (e) {
    return e.code ?? String(e)
  }
}
const dir = mkdtempSync(join(tmpdir(), 'slate-initstate-'))
const out = {}
try {
  if (mode === 'missing') {
    out.init = code(() => native.init(join(dir, 'openssl-fips.cnf'), join(dir, 'no-such-dir'), true))
  } else if (mode === 'wrongPin') {
    // A provider file that is not the pinned module: the digest check refuses it (SCC_15).
    for (const f of ['fips.so', 'fips.dylib']) writeFileSync(join(dir, f), 'not the module')
    writeFileSync(join(dir, 'openssl-fips.cnf'), '')
    out.init = code(() => native.init(join(dir, 'openssl-fips.cnf'), dir, true))
  } else if (mode === 'errorBeforeInit') {
    // The desktop's packaged path with no provider: enterErrorState without any init, then status().
    out.enter = code(() => native.enterErrorState())
  }
  const s = native.status()
  out.status = {
    ready: s.ready,
    errorState: s.errorState,
    fipsActive: s.fipsActive,
    postPassed: s.postPassed,
    liveHandles: s.liveHandles,
    secureHeapUsed: s.secureHeapUsed,
    fipsModule: s.fipsModule,
    defaultContextProviders: s.defaultContextProviders,
  }
  out.zeroize = native.zeroizeAll()
  out.random = code(() => native.randomBytes(4))
  out.sha256 = code(() => native.sha256(new Uint8Array(4)))
  out.keyRandom = code(() => native.keyRandom('db'))
  out.postBegin = code(() => native.postBegin())
  out.statusAgain = native.status().errorState
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(out))
