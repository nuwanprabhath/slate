// T-ZERO-04 / T-ZERO-07 (audit §6.3, C7): what the e2e memory tests need from the main process, a full
// garbage collection and a V8 heap snapshot. They reach it only through Playwright's app.evaluate (the
// inspector), never from a page, and only when an e2e run sets the hook: a packaged app scrubs both
// variables at start (TEST_HOOK_VARS), so these globals never exist there.
import { setFlagsFromString, writeHeapSnapshot } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { env } from './testHooks'

export interface MemoryProbeGlobals {
  gc?: () => void
  /** Writes a heap snapshot to `file` and returns its path. */
  __slateHeapSnapshot?: (file: string) => string
}

export function installMemoryProbes(isE2E: boolean, target: MemoryProbeGlobals = globalThis as MemoryProbeGlobals): void {
  if (!isE2E) return
  if (env('SLATE_TEST_EXPOSE_GC') === '1') {
    setFlagsFromString('--expose_gc')
    // The flag takes effect for new contexts; a fresh one hands over its `gc`.
    target.gc = runInNewContext('gc') as () => void
  }
  if (env('SLATE_TEST_HEAP_SNAPSHOT') === '1') target.__slateHeapSnapshot = (file: string) => writeHeapSnapshot(file)
}
