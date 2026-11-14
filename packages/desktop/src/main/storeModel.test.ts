// A command model of DocStore over a real (plain or SQLCipher-keyed) database: whatever order updates
// arrive in, duplicated, from a second connection, across compaction, reopen and removal, the store
// holds exactly what was acknowledged, and an incremental reader agrees with a full load.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { LoroDoc } from 'loro-crdt'
import { COMPACT_IDLE_MS, DocStore, type DocCursor } from './store'
import { testKey } from './db/testModule'
import { dbModule } from './db/dbModule'
import { fcParams, fuzzTimeout } from '../../test/fuzz'

const A = 'page:a'
const B = 'page:b'
const EDITS = 12

/** Per-commit updates of one doc, each exportable on its own (as `textEdits` in store.test.ts). */
function textEdits(n: number, prefix: string): Uint8Array[] {
  const doc = new LoroDoc()
  const updates: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const from = doc.oplogVersion()
    doc.getText('t').insert(doc.getText('t').length, `${prefix}${i} `)
    doc.commit()
    updates.push(doc.export({ mode: 'update', from }))
  }
  return updates
}

function docOf(parts: Uint8Array[]): LoroDoc {
  const doc = new LoroDoc()
  if (parts.length > 0) doc.importBatch(parts)
  return doc
}

/**
 * The text and the oplog version, not `toJSON()`: a doc that imported only pending updates lists an
 * empty `t` that a doc given the same updates in one batch does not, and neither holds an edit.
 */
function expectSameDoc(actual: LoroDoc, expected: LoroDoc, what: string): void {
  expect(actual.getText('t').toString(), what).toEqual(expected.getText('t').toString())
  expect(actual.oplogVersion().toJSON(), what).toEqual(expected.oplogVersion().toJSON())
}

type Op =
  | { t: 'append' }
  | { t: 'withhold' }
  | { t: 'deliver'; i: number }
  | { t: 'duplicate'; i: number }
  | { t: 'second' }
  | { t: 'compact' }
  | { t: 'reopen' }
  | { t: 'read' }
  | { t: 'remove' }
  | { t: 'other' }

const op: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.constant<Op>({ t: 'append' }), weight: 4 },
  { arbitrary: fc.constant<Op>({ t: 'withhold' }), weight: 2 },
  { arbitrary: fc.nat(20).map<Op>((i) => ({ t: 'deliver', i })), weight: 2 },
  fc.nat(20).map<Op>((i) => ({ t: 'duplicate', i })),
  { arbitrary: fc.constant<Op>({ t: 'second' }), weight: 2 },
  { arbitrary: fc.constant<Op>({ t: 'compact' }), weight: 2 },
  fc.constant<Op>({ t: 'reopen' }),
  { arbitrary: fc.constant<Op>({ t: 'read' }), weight: 2 },
  fc.constant<Op>({ t: 'remove' }),
  fc.constant<Op>({ t: 'other' }),
)

const dirs: string[] = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-storemodel-'))
  dirs.push(dir)
  return join(dir, 'slate.db')
}
// Per run as well as per test: at soak depth one test leaves ten thousand folders, more than a hook can delete in time.
const removeDirs = (): void => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
afterEach(() => {
  vi.useRealTimers()
  removeDirs()
})

/** One run of the model; every invariant is checked after every command. */
function runModel(ops: Op[], keyed: boolean, afterOpen: () => void = () => {}): void {
  const file = tempDb()
  const key = keyed ? testKey() : null
  const truthA = textEdits(EDITS, 'a')
  const truthB = textEdits(EDITS, 'b')
  const m = { next: 0, delivered: [] as Uint8Array[], withheld: [] as Uint8Array[], removed: false, nextB: 0, deliveredB: [] as Uint8Array[] }
  let reader: { doc: LoroDoc; cursor: DocCursor | undefined; fresh: boolean } = { doc: new LoroDoc(), cursor: undefined, fresh: false }
  let toldFull = false
  const read = (s: DocStore): void => {
    const r = s.loadSince(A, reader.cursor)
    if (r.full) {
      reader.doc = new LoroDoc()
      toldFull = true
    }
    if (r.parts.length > 0) reader.doc.importBatch(r.parts)
    reader.cursor = r.cursor
    reader.fresh = true
  }
  // The app wires the external watcher here: it folds the other connection's rows before they go.
  const open = (): DocStore => new DocStore(file, { key, beforeCompact: (id) => id === A && read(store) })
  let store = open()
  const second = new DocStore(file, { key, compact: false })
  let seq = 0
  try {
    afterOpen()
    for (const o of ops) {
      const seqBefore = seq
      let appended: string | null = null
      reader.fresh = false
      toldFull = false
      switch (o.t) {
        case 'append':
        case 'second': {
          const u = truthA[m.next]
          if (!u) break
          m.next++
          ;(o.t === 'append' ? store : second).append(A, u)
          m.delivered.push(u)
          appended = A
          break
        }
        case 'withhold': {
          const u = truthA[m.next]
          if (!u) break
          m.next++
          m.withheld.push(u)
          break
        }
        case 'deliver': {
          if (m.withheld.length === 0) break
          const [u] = m.withheld.splice(o.i % m.withheld.length, 1)
          store.append(A, u!)
          m.delivered.push(u!)
          appended = A
          break
        }
        case 'duplicate': {
          const u = m.delivered[o.i % Math.max(1, m.delivered.length)]
          if (!u) break
          store.append(A, u)
          m.delivered.push(u)
          appended = A
          break
        }
        case 'compact': {
          const pending = new LoroDoc().importBatch(store.load(A)).pending
          const rows = store.load(A).length
          store.compact(A)
          // A gap keeps every row: the store does not trust a snapshot to carry an update still pending.
          if (pending !== null && pending.size > 0) expect(store.load(A), 'rows kept across a gap').toHaveLength(rows)
          break
        }
        case 'reopen':
          store.close()
          store = open()
          // The reader's cursor belongs to the connection that served it, as the app's page session does.
          reader = { doc: new LoroDoc(), cursor: undefined, fresh: false }
          break
        case 'read':
          read(store)
          break
        case 'remove':
          store.remove(A)
          m.delivered = []
          m.removed = true
          break
        case 'other': {
          const u = truthB[m.nextB]
          if (!u) break
          m.nextB++
          store.append(B, u)
          m.deliveredB.push(u)
          appended = B
          break
        }
      }
      // 1. The store holds exactly the acknowledged updates, of both docs.
      const loaded = docOf(store.load(A))
      expectSameDoc(loaded, docOf(m.delivered), `${A} after ${o.t}`)
      expectSameDoc(docOf(store.load(B)), docOf(m.deliveredB), `${B} after ${o.t}`)
      if (!m.removed && m.withheld.length === 0) expectSameDoc(loaded, docOf(truthA.slice(0, m.next)), `${A} vs truth after ${o.t}`)
      // 2. A reader that just read agrees with the full load.
      if (reader.fresh) expectSameDoc(reader.doc, loaded, `reader after ${o.t}`)
      // 3. The change cursor never goes back, and lists what was appended since it.
      const changed = store.changedDocs(seqBefore)
      expect(changed.seq).toBeGreaterThanOrEqual(seqBefore)
      if (appended !== null) expect(changed.ids).toContain(appended)
      seq = changed.seq
      // 4. A removed doc loads empty and its reader starts over.
      if (o.t === 'remove') {
        expect(store.load(A)).toEqual([])
        if (reader.cursor !== undefined) {
          read(store)
          expect(toldFull).toBe(true)
          expectSameDoc(reader.doc, new LoroDoc(), 'reader after remove')
        }
      }
    }
  } finally {
    second.close()
    store.close()
    if (key) dbModule().native.keyDestroy(key)
    removeDirs()
  }
}

describe('DocStore model', () => {
  it(
    'T-F2A-01: compaction, reopen, a second connection and removal never lose an acknowledged update, in any order of arrival',
    () => {
      vi.useFakeTimers()
      fc.assert(
        fc.property(fc.array(op, { maxLength: 30 }), fc.boolean(), (ops, keyed) => runModel(ops, keyed)),
        { ...fcParams, numRuns: Math.max(50, Math.floor(fcParams.numRuns / 20)) },
      )
    },
    fuzzTimeout(20_000),
  )

  it(
    'T-F2A-02: crossing the compaction threshold folds the rows on idle, and holds them while one is withheld',
    () => {
      vi.useFakeTimers()
      fc.assert(
        fc.property(fc.integer({ min: 500, max: 540 }), fc.option(fc.nat(499), { nil: null }), fc.boolean(), (n, gap, keyed) => {
          const file = tempDb()
          const updates = textEdits(n, 'w')
          const key = keyed ? testKey() : null
          const store = new DocStore(file, { key })
          try {
            const delivered = updates.filter((_, i) => i !== gap)
            for (const u of delivered) store.append(A, u)
            vi.advanceTimersByTime(COMPACT_IDLE_MS)
            expectSameDoc(docOf(store.load(A)), docOf(delivered), 'after idle')
            // Folded to one snapshot unless a gap keeps the rows; a gap at the last edit leaves nothing pending.
            if (gap === null || gap === n - 1) expect(store.load(A)).toHaveLength(1)
            else expect(store.load(A)).toHaveLength(delivered.length)
            if (gap !== null) {
              store.append(A, updates[gap]!)
              vi.advanceTimersByTime(COMPACT_IDLE_MS)
              const loaded = docOf(store.load(A))
              expectSameDoc(loaded, docOf(updates), 'after the gap is filled')
            }
          } finally {
            store.close()
            if (key) dbModule().native.keyDestroy(key)
            removeDirs()
          }
        }),
        { ...fcParams, numRuns: Math.max(5, Math.floor(fcParams.numRuns / 200)) },
      )
    },
    fuzzTimeout(40_000),
  )

  // The module has 64 key slots (MAX_HANDLES); a run that keeps its key spends one for the whole process.
  const moduleUse = (): { used: number; live: number } => {
    const s = dbModule().native.status()
    return { used: s.secureHeapUsed, live: s.liveHandles }
  }

  it('FX-29: a keyed model run gives its key handle and secure heap back, even when the run fails', () => {
    const before = moduleUse()
    for (let i = 0; i < 100; i++) runModel([{ t: 'append' }, { t: 'reopen' }, { t: 'second' }], true)
    expect(() => runModel([{ t: 'append' }], true, () => { throw new Error('a failing case') })).toThrow('a failing case')
    expect(moduleUse()).toEqual(before)
  })

  it('FX-29: opening and closing a keyed DocStore 200 times on one key spends no secure heap and no handle', () => {
    const key = testKey()
    try {
      const before = moduleUse()
      for (let i = 0; i < 200; i++) new DocStore(tempDb(), { key }).close()
      expect(moduleUse()).toEqual(before)
    } finally {
      dbModule().native.keyDestroy(key)
    }
  })

  it('FX-6: an append after removing the doc that held the newest seq is listed to a cursor taken before the remove, also after a reopen', () => {
    const file = tempDb()
    const u = textEdits(3, 'x')
    let store = new DocStore(file, { key: null })
    try {
      store.append(A, u[0]!)
      store.append(B, u[1]!)
      const cursor = store.headSeq()
      store.remove(B)
      expect(store.headSeq()).toBe(cursor)
      store.close()
      store = new DocStore(file, { key: null })
      store.append(A, u[2]!)
      expect(store.changedDocs(cursor).ids).toEqual([A])
      expect(store.headSeq()).toBeGreaterThan(cursor)
    } finally {
      store.close()
    }
  })
})
