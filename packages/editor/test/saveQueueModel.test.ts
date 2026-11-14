import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import * as loro from 'loro-crdt'
import { LoroDoc } from 'loro-crdt'
import { SaveQueue, type SaveSink } from '../src/saveQueue'
import { fcParams } from '../../desktop/test/fuzz'

// T-F2B: a SaveQueue over a live LoroDoc and a scripted sink. The model is the list of updates the sink
// acknowledged; the real queue must never store an update that depends on one the sink rejected.

type Outcome = 'ok' | 'reject' | 'late'

/** Each append takes the next scripted outcome (default `ok`); `late` resolves after a timer. */
class ScriptedSink implements SaveSink {
  readonly stored: Uint8Array[] = []
  outcomes: Outcome[] = []
  /** When set, every append rejects regardless of the script. */
  rejectAll = false
  async append(_docId: string, update: Uint8Array): Promise<void> {
    const o: Outcome = this.rejectAll ? 'reject' : (this.outcomes.shift() ?? 'ok')
    if (o === 'reject') throw new Error('rejected')
    if (o === 'late') await new Promise<void>((r) => setTimeout(r, 40))
    this.stored.push(update)
  }
}

interface Model {
  doc: LoroDoc
  sink: ScriptedSink
  q: SaveQueue
  edits: number
  /** Set by `close`: a closed queue stops retrying, so the convergence property no longer holds. */
  closed: boolean
}

type Cmd = fc.AsyncCommand<Model, Record<string, never>>

const flush = async (): Promise<void> => {
  // Microtasks only: a flush hops several awaits before its first append.
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const outcomeArb = fc.constantFrom<Outcome>('ok', 'reject', 'late')

const editCmd = (text: string): Cmd => ({
  check: () => true,
  toString: () => `edit(${text})`,
  run: async (m) => {
    const t = m.doc.getText('t')
    t.insert(t.length, text)
    m.doc.commit()
    m.edits++
    await flush()
  },
})
const burstCmd = (n: number): Cmd => ({
  check: () => true,
  toString: () => `burst(${n})`,
  run: async (m) => {
    for (let i = 0; i < n; i++) {
      const t = m.doc.getText('t')
      t.insert(t.length, 'b')
      m.doc.commit()
      m.edits++
    }
    await flush()
  },
})
const scriptCmd = (outs: Outcome[]): Cmd => ({
  check: () => true,
  toString: () => `script(${outs.join(',')})`,
  run: async (m) => {
    m.sink.outcomes = [...outs]
  },
})
const advanceCmd = (ms: number): Cmd => ({
  check: () => true,
  toString: () => `advance(${ms})`,
  run: async (m) => {
    await vi.advanceTimersByTimeAsync(ms)
  },
})
const idleCmd = (timeoutMs: number): Cmd => ({
  check: () => true,
  toString: () => `idle(${timeoutMs})`,
  run: async (m) => {
    // Property 4: settles within timeoutMs. Advancing exactly that long must resolve the promise.
    let settled = false
    const p = m.q.idle(timeoutMs).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(timeoutMs)
    await flush()
    expect(settled).toBe(true)
    await p
  },
})
const closeCmd = (): Cmd => ({
  check: (m) => !m.closed,
  toString: () => 'close()',
  run: async (m) => {
    m.q.close()
    m.closed = true
    await flush()
  },
})
const rejectAllCmd = (on: boolean): Cmd => ({
  check: () => true,
  toString: () => `rejectAll(${on})`,
  run: async (m) => {
    m.sink.rejectAll = on
  },
})

/** The same command with properties 1 and 3 checked once it has run. */
const checked = (c: Cmd): Cmd => ({
  check: (m) => c.check(m),
  toString: () => c.toString(),
  run: async (m, r) => {
    await c.run(m, r)
    checkStored(m)
  },
})

const commands = [
  fc.string({ minLength: 1, maxLength: 4 }).map(editCmd).map(checked),
  fc.integer({ min: 2, max: 6 }).map(burstCmd).map(checked),
  fc.array(outcomeArb, { maxLength: 4 }).map(scriptCmd).map(checked),
  fc.constantFrom(250, 500, 1000, 5000, 10).map(advanceCmd).map(checked),
  fc.integer({ min: 1, max: 3000 }).map(idleCmd).map(checked),
  fc.constant(checked(closeCmd())),
  fc.boolean().map(rejectAllCmd).map(checked),
]

/** Properties 1 and 3 over one state. `checked` runs this after every command, so a violation names the step that caused it. */
function checkStored(m: Model): void {
  const fresh = new LoroDoc()
  const status = fresh.importBatch(m.sink.stored)
  fresh.free()
  expect(status.pending ?? null).toBeNull()
  // Property 3: with the sink rejecting everything and edits unacknowledged, never `saved`.
  if (m.sink.rejectAll && !m.closed) {
    const stored = new LoroDoc()
    stored.importBatch(m.sink.stored)
    const same = JSON.stringify(stored.toJSON()) === JSON.stringify(m.doc.toJSON())
    stored.free()
    if (!same) expect(m.q.state).not.toBe('saved')
  }
}

describe('SaveQueue model', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('T-F2B-01: stored updates never depend on a rejected one; settling converges (properties 1-4)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 25 }), run),
      { ...fcParams, numRuns: Math.max(100, Math.floor(fcParams.numRuns / 10)) },
    )
  })

  it("T-F2B-02: a run gives back the Loro documents it built, so Loro's WebAssembly heap stops growing (FX-44)", async () => {
    const cmds: Cmd[] = [
      editCmd('abc'), burstCmd(4), scriptCmd(['reject', 'late', 'ok']), editCmd('d'), advanceCmd(500),
      rejectAllCmd(true), burstCmd(3), idleCmd(1000), rejectAllCmd(false), advanceCmd(5000), editCmd('ef'),
    ].map(checked)
    const runs = async (n: number) => {
      for (let i = 0; i < n; i++) await run(cmds)
    }
    await runs(SETTLE_RUNS)
    const settled = loroHeapBytes()
    await runs(MEASURED_RUNS)
    expect((loroHeapBytes() - settled) / MEASURED_RUNS, 'bytes of Loro heap a run kept').toBeLessThan(KEPT_BYTES_PER_RUN)
    // 600 runs take seconds; the deadline is a hundred times that, for a machine shared with other suites.
  }, 600_000)
})

async function run(cmds: Iterable<Cmd>): Promise<void> {
  const doc = new LoroDoc()
  const sink = new ScriptedSink()
  const q = new SaveQueue('d', doc, sink)
  const m: Model = { doc, sink, q, edits: 0, closed: false }
  try {
    await fc.asyncModelRun(() => ({ model: m, real: {} as Record<string, never> }), cmds)
    // `checked` held properties 1 and 3 after every command; hold them on the final state too.
    checkStored(m)
    if (!m.closed) {
      // Property 2: the sink accepts again, the timers run, and the stored copy equals the live one.
      sink.rejectAll = false
      sink.outcomes = []
      await vi.advanceTimersByTimeAsync(20_000)
      await flush()
      expect(q.state).toBe('saved')
      const stored = new LoroDoc()
      stored.importBatch(sink.stored)
      const json = stored.toJSON()
      stored.free()
      expect(json).toEqual(doc.toJSON())
    }
    checkStored(m)
  } finally {
    q.close()
    doc.free()
    // free() releases nothing while a handle read from the doc (the commands' getText) is alive; only Loro's
    // FinalizationRegistry frees those, in a task of its own. The test's fake timers replace setImmediate, so the
    // turn is taken through the real one (FX-44).
    await new Promise((resolve) => realSetImmediate(resolve))
  }
}

const realSetImmediate = setImmediate

/** The size of Loro's WebAssembly heap. It never shrinks, so growth is memory no earlier run gave back for reuse. */
const loroHeapBytes = (): number => (loro as unknown as { __wasm: { memory: { buffer: ArrayBuffer } } }).__wasm.memory.buffer.byteLength
/**
 * T-F2B-02's bound. Over 1000 settled runs a run keeps about 1.4 kB with its documents freed and 2.0 kB without; at
 * 300 runs the collector's pace swamps that (5-10 kB either way). 32 KiB catches a run that keeps its documents
 * outright (searchFuzz's kept 286 kB, FX-44) without reading the collector's noise. Bytes, not a time.
 */
const SETTLE_RUNS = 300
const MEASURED_RUNS = 300
const KEPT_BYTES_PER_RUN = 32 * 1024
