// The store's hot path on a real encrypted database: 1,000 appends to one doc, the shape an editing
// session produces. It is a measurement, not a threshold - the ceiling only catches an order-of-
// magnitude regression. The number is written to the file below so a run can be compared with another.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DocStore } from './store'
import { testKey } from './db/testModule'

// testSetup.ts points TMPDIR at a per-run dir that the run deletes, so the result goes in its parent.
export const BENCH_RESULT_FILE = join(dirname(tmpdir()), 'slate-store-bench.json')
const APPENDS = 1_000

describe('store hot path (B4)', () => {
  it('B4-BENCH: 1,000 appends on an encrypted database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-bench-'))
    const store = new DocStore(join(dir, 'slate.db'), { key: testKey() })
    const update = new Uint8Array(256).fill(7)
    const started = process.hrtime.bigint()
    for (let i = 0; i < APPENDS; i++) store.append('page:bench', update)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    store.close()
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(BENCH_RESULT_FILE, JSON.stringify({ appends: APPENDS, totalMs: ms, perAppendMs: ms / APPENDS }))
    expect(ms).toBeLessThan(20_000)
  })
})
