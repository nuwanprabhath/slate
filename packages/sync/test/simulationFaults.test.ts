// Fault-injection property test (review F8): three devices share one drive that refuses calls, loses answers, stalls,
// crashes the process, and omits, reorders or repeats delta items, at plan-chosen calls. After the faults stop and
// every device syncs to quiescence they must hold identical documents, with no local edit missing.
import { isDeepStrictEqual } from 'node:util'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PageDoc } from '@slate/core'
import { SyncAborted, SyncEngine } from '../src/engine'
import type { SyncReport } from '../src/types'
import { FAULT_KINDS, faultyDrive, type CallFault, type DeltaFault, type FaultKind, type FaultPlan, type FaultyDrive, type HangKind } from './faultyDrive'
import { memoryDrive } from './memoryDrive'
import { addTextBox, appendText, boxText, editPage, memoryLocal, type MemoryLocal } from './memoryLocal'
import { NOTEBOOK, PAGE } from './simulation'

const RUNS = Number(process.env.SLATE_SIM_RUNS) || 500
const SEED = Number(process.env.SLATE_SIM_SEED) || 0x51a7e
/** How long a sync may wait on one call before the harness aborts it. */
const DEADLINE_MS = 30_000
const DEVICES = ['d1', 'd2', 'd3'] as const

type Op = 'sync' | 'box' | 'text' | 'move' | 'del' | 'note'
interface Action {
  op: Op
  dev: number
  pick: number
}
interface Scenario {
  plans: FaultPlan[]
  actions: Action[]
}

// Weighted by repetition; syncs are common enough that faults land inside them.
const OPS: Op[] = ['sync', 'sync', 'sync', 'sync', 'box', 'box', 'text', 'text', 'text', 'move', 'del', 'note', 'note']

const callFault: fc.Arbitrary<CallFault> = fc.oneof(
  fc.constant<CallFault>({ kind: 'offline' }),
  fc.constant<CallFault>({ kind: 'lostAck' }),
  fc.boolean().map<CallFault>((applied) => ({ kind: 'stall', applied })),
  fc.boolean().map<CallFault>((applied) => ({ kind: 'crash', applied })),
  fc.constant<CallFault>({ kind: 'dupWrite' })
)
const deltaFault: fc.Arbitrary<DeltaFault> = fc.record({ kind: fc.constantFrom('omit', 'reorder', 'dupDelta'), salt: fc.nat(0xffff) })
const plan: fc.Arbitrary<FaultPlan> = fc
  .record({
    calls: fc.array(fc.tuple(fc.nat(34), callFault), { maxLength: 7 }),
    deltas: fc.array(fc.tuple(fc.nat(10), deltaFault), { maxLength: 4 })
  })
  .map(({ calls, deltas }) => ({ calls: Object.fromEntries(calls), deltas: Object.fromEntries(deltas) }))
const scenario: fc.Arbitrary<Scenario> = fc.record({
  plans: fc.tuple(plan, plan, plan),
  actions: fc.array(fc.record({ op: fc.constantFrom(...OPS), dev: fc.nat(2), pick: fc.nat(99) }), { minLength: 10, maxLength: 28 })
})

interface Dev {
  id: string
  local: MemoryLocal
  drive: FaultyDrive
  engine: SyncEngine
  /** A fresh engine over the same LocalStore: what a restarted process has. */
  restart(): SyncEngine
}

/** Everything the runs together did: proof that each fault kind fired and that its consequence was handled. */
const totals = { runs: 0, fired: Object.fromEntries(FAULT_KINDS.map((k) => [k, 0])) as Record<FaultKind, number>, aborted: 0, restarted: 0, compacted: 0 }

/** Runs one sync as the app does: with an abort signal and a deadline. A hung call is aborted (stall) or the engine dropped (crash). */
async function syncWithFaults(d: Dev): Promise<SyncReport | 'aborted' | 'crashed'> {
  const abort = new AbortController()
  const hung = new Promise<HangKind>((resolve) => (d.drive.onHang = resolve))
  const run = d.engine.syncOnce({ signal: abort.signal }).then(
    (report) => ({ report }),
    (error: unknown) => ({ error })
  )
  const deadline = setTimeout(() => abort.abort(), DEADLINE_MS)
  const first = await Promise.race([run, hung])
  if (first !== 'stall') clearTimeout(deadline)
  if (first === 'crash') {
    d.engine = d.restart()
    totals.restarted++
    return 'crashed'
  }
  if (first === 'stall') {
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    await new Promise((resolve) => setImmediate(resolve))
    const settled = await Promise.race([run, Promise.resolve('pending' as const)])
    if (settled === 'pending') throw new Error('a stalled sync did not stop when its deadline aborted it')
    if (!('error' in settled) || !(settled.error instanceof SyncAborted)) throw new Error(`an aborted sync did not throw SyncAborted: ${JSON.stringify(settled)}`)
    totals.aborted++
    return 'aborted'
  }
  if (!('report' in first)) throw first.error
  if (first.report.status !== 'idle-synced' && first.report.status !== 'offline') throw new Error(`sync failed under faults: ${first.report.status} ${first.report.message ?? ''}`)
  return first.report
}

async function run(s: Scenario): Promise<void> {
  const shared = memoryDrive()
  let nextPeer = 1000n
  const edited = { notes: [] as string[], boxes: new Map<string, string[]>(), deleted: new Set<string>() }
  const devices: Dev[] = DEVICES.map((id, i) => {
    const local = memoryLocal()
    const drive = faultyDrive(shared, s.plans[i]!)
    const restart = () => new SyncEngine({ local, remote: drive, deviceId: id, deviceName: id, compactAfter: 1 })
    return { id, local, drive, engine: restart(), restart }
  })

  for (const [step, a] of s.actions.entries()) {
    const d = devices[a.dev]!
    const boxIds = () => new PageDoc(d.local.doc(PAGE)).listBoxes().map((b) => b.id)
    const some = () => boxIds()[a.pick % Math.max(1, boxIds().length)]
    switch (a.op) {
      case 'sync':
        await syncWithFaults(d)
        break
      case 'box': {
        const id = editPage(d.local, PAGE, (p) => addTextBox(p, `b${step}`, { x: a.pick, y: 0 }), nextPeer++)
        edited.boxes.set(id, [`b${step}`])
        break
      }
      case 'text': {
        const id = some()
        if (id === undefined) break
        const token = `${d.id}:${step} `
        editPage(d.local, PAGE, (p) => appendText(p, id, token), nextPeer++)
        edited.boxes.get(id)?.push(token)
        break
      }
      case 'move': {
        const id = some()
        if (id !== undefined) editPage(d.local, PAGE, (p) => p.updateBox(id, { y: a.pick * 20 }), nextPeer++)
        break
      }
      case 'del': {
        const id = some()
        if (id === undefined || boxIds().length < 2) break
        editPage(d.local, PAGE, (p) => p.deleteBox(id), nextPeer++)
        edited.deleted.add(id)
        break
      }
      case 'note': {
        const name = `n${step}`
        editPage(d.local, NOTEBOOK, (p) => p.doc.getMap('pages').set(name, d.id), nextPeer++)
        edited.notes.push(name)
        break
      }
    }
  }

  // Faults stop. Twice reaches everyone; a box restored on pulling a delete is a new local change, so rounds
  // continue until one pushes nothing.
  for (const d of devices) d.drive.enabled = false
  for (let round = 0, pushed = 1; round < 2 || pushed > 0; round++) {
    if (round >= 8) throw new Error('devices did not reach quiescence in 8 rounds')
    pushed = 0
    for (const d of devices) {
      const report = await d.engine.syncOnce()
      if (report.status !== 'idle-synced') throw new Error(`quiescent sync failed: ${report.status} ${report.message ?? ''}`)
      pushed += report.pushed
    }
  }

  totals.runs++
  if ([...shared.files.keys()].some((path) => path.includes('/snapshot-'))) totals.compacted++
  for (const d of devices) for (const k of FAULT_KINDS) totals.fired[k] += d.drive.fired[k]
  verify(devices, edited)
}

function verify(devices: Dev[], edited: { notes: string[]; boxes: Map<string, string[]>; deleted: Set<string> }): void {
  const [first, ...rest] = devices as [Dev, ...Dev[]]
  for (const docId of [PAGE, NOTEBOOK]) {
    const expected = first.local.doc(docId).toJSON()
    for (const d of rest) if (!isDeepStrictEqual(d.local.doc(docId).toJSON(), expected)) throw new Error(`${d.id} and ${first.id} hold different ${docId}`)
  }
  for (const d of devices) {
    const notes = d.local.doc(NOTEBOOK).getMap('pages')
    const lostNotes = edited.notes.filter((n) => notes.get(n) === undefined)
    if (lostNotes.length > 0) throw new Error(`${d.id} lost notebook edits ${lostNotes.join(',')}`)
    const page = new PageDoc(d.local.doc(PAGE))
    const present = new Set(page.listBoxes().map((b) => b.id))
    for (const [id, tokens] of edited.boxes) {
      if (edited.deleted.has(id)) continue
      if (!present.has(id)) throw new Error(`${d.id} lost box ${id}`)
      const text = boxText(page, id) ?? ''
      const lost = tokens.filter((t) => !text.includes(t))
      if (lost.length > 0) throw new Error(`${d.id} lost text ${JSON.stringify(lost)} of box ${id}`)
    }
  }
}

describe('three devices over a faulty drive', () => {
  beforeAll(() => {
    // Only timeouts: the engine's clock and the microtask queue stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it(`converge with no edit lost, over ${RUNS} generated fault plans`, { timeout: Math.max(55_000, RUNS * 120) }, async () => {
    await fc.assert(
      fc.asyncProperty(scenario, (s) => run(s)),
      { numRuns: RUNS, seed: SEED }
    )
    expect(totals.runs).toBe(RUNS)
    for (const kind of FAULT_KINDS) expect(totals.fired[kind], `${kind} fired`).toBeGreaterThan(0)
    expect(totals.aborted, 'stalled syncs aborted').toBeGreaterThan(0)
    expect(totals.restarted, 'engines restarted after a crash').toBeGreaterThan(0)
    expect(totals.compacted, 'runs that compacted').toBeGreaterThan(RUNS / 2)
  })
})
