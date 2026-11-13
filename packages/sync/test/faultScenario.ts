// The three-device fault scenario: its arbitraries, `run` (play one scenario to quiescence) and `verify` (identical
// documents, no local edit lost). simulationFaults.test.ts runs it; other sync harnesses build on it.
import { isDeepStrictEqual } from 'node:util'
import fc from 'fast-check'
import { vi } from 'vitest'
import { PageDoc } from '@slate/core'
import { SyncAborted, SyncEngine } from '../src/engine'
import type { SyncReport } from '../src/types'
import { FAULT_KINDS, faultyDrive, type CallFault, type DeltaFault, type FaultKind, type FaultPlan, type FaultyDrive, type HangKind } from './faultyDrive'
import { memoryDrive, type MemoryDrive } from './memoryDrive'
import { addTextBox, appendText, boxText, editPage, memoryLocal, type MemoryLocal } from './memoryLocal'
import { NOTEBOOK, PAGE } from './simulation'

/** How long a sync may wait on one call before the harness aborts it. */
export const DEADLINE_MS = 30_000
export const DEVICES = ['d1', 'd2', 'd3'] as const

export type Op = 'sync' | 'box' | 'text' | 'move' | 'del' | 'note'
export interface Action {
  op: Op
  dev: number
  pick: number
}
export interface Scenario {
  plans: FaultPlan[]
  actions: Action[]
}

// Weighted by repetition; syncs are common enough that faults land inside them.
export const OPS: Op[] = ['sync', 'sync', 'sync', 'sync', 'box', 'box', 'text', 'text', 'text', 'move', 'del', 'note', 'note']

export const callFault: fc.Arbitrary<CallFault> = fc.oneof(
  fc.constant<CallFault>({ kind: 'offline' }),
  fc.constant<CallFault>({ kind: 'lostAck' }),
  fc.boolean().map<CallFault>((applied) => ({ kind: 'stall', applied })),
  fc.boolean().map<CallFault>((applied) => ({ kind: 'crash', applied })),
  fc.constant<CallFault>({ kind: 'dupWrite' })
)
export const deltaFault: fc.Arbitrary<DeltaFault> = fc.record({ kind: fc.constantFrom('omit', 'reorder', 'dupDelta'), salt: fc.nat(0xffff) })
export const plan: fc.Arbitrary<FaultPlan> = fc
  .record({
    calls: fc.array(fc.tuple(fc.nat(34), callFault), { maxLength: 7 }),
    deltas: fc.array(fc.tuple(fc.nat(10), deltaFault), { maxLength: 4 })
  })
  .map(({ calls, deltas }) => ({ calls: Object.fromEntries(calls), deltas: Object.fromEntries(deltas) }))
export const scenario: fc.Arbitrary<Scenario> = fc.record({
  plans: fc.tuple(plan, plan, plan),
  actions: fc.array(fc.record({ op: fc.constantFrom(...OPS), dev: fc.nat(2), pick: fc.nat(99) }), { minLength: 10, maxLength: 28 })
})

export interface Dev {
  id: string
  local: MemoryLocal
  drive: FaultyDrive
  engine: SyncEngine
  /** A fresh engine over the same LocalStore: what a restarted process has. */
  restart(): SyncEngine
}

export interface Edited {
  notes: string[]
  boxes: Map<string, string[]>
  deleted: Set<string>
}

/** Everything the runs together did: proof that each fault kind fired and that its consequence was handled. */
export const totals = { runs: 0, fired: Object.fromEntries(FAULT_KINDS.map((k) => [k, 0])) as Record<FaultKind, number>, aborted: 0, restarted: 0, compacted: 0 }

/** Runs one sync as the app does: with an abort signal and a deadline. A hung call is aborted (stall) or the engine dropped (crash). */
export async function syncWithFaults(d: Dev): Promise<SyncReport | 'aborted' | 'crashed'> {
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

/** The three devices over one shared drive, each behind its own fault plan. */
export function world(plans: readonly FaultPlan[]): { shared: MemoryDrive; devices: Dev[] } {
  const shared = memoryDrive()
  const devices: Dev[] = DEVICES.map((id, i) => {
    const local = memoryLocal()
    const drive = faultyDrive(shared, plans[i]!)
    const restart = () => new SyncEngine({ local, remote: drive, deviceId: id, deviceName: id, compactAfter: 1 })
    return { id, local, drive, engine: restart(), restart }
  })
  return { shared, devices }
}

/**
 * Faults stop and every device syncs until nothing moves. Twice reaches everyone; a box restored on pulling a delete
 * is a new local change, so rounds continue until one pushes nothing. That round cannot itself restore a box: a
 * restore needs an edit made since the device's last finished sync, and after the first round the only such edits
 * are earlier restores, which no other device has seen and so cannot have deleted (FX-24).
 */
export async function quiesce(devices: Dev[]): Promise<void> {
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
}

/**
 * What one play of a scenario did, in a form two plays compare by: what each action acted on and how each sync
 * ended, then the quiescent state. Neither the clock nor a Loro peer id is in it (the engine picks its own peer for
 * a restored box), so equal outcomes mean the plan was replayed, not merely that it converged again.
 */
export interface Outcome {
  trace: string[]
  /** Per device: its page and notebook, its conflict records, how many boxes it restored, the faults that fired. */
  devices: Array<{ docs: unknown[]; conflicts: unknown[]; restored: number; fired: Record<FaultKind, number> }>
  remote: string[]
}

export async function run(s: Scenario): Promise<void> {
  await play(s)
}

export async function play(s: Scenario): Promise<Outcome> {
  const { shared, devices } = world(s.plans)
  let nextPeer = 1000n
  const edited: Edited = { notes: [], boxes: new Map<string, string[]>(), deleted: new Set<string>() }
  const trace: string[] = []

  for (const [step, a] of s.actions.entries()) {
    const d = devices[a.dev]!
    const boxIds = () => new PageDoc(d.local.doc(PAGE)).listBoxes().map((b) => b.id)
    const some = () => boxIds()[a.pick % Math.max(1, boxIds().length)]
    switch (a.op) {
      case 'sync': {
        const result = await syncWithFaults(d)
        trace.push(`sync ${d.id} ${typeof result === 'string' ? result : `${result.status} pushed ${result.pushed} pulled ${result.pulled} conflicts ${result.conflicts}`}`)
        break
      }
      case 'box': {
        const id = editPage(d.local, PAGE, (p) => addTextBox(p, `b${step}`, { x: a.pick, y: 0 }), nextPeer++)
        edited.boxes.set(id, [`b${step}`])
        trace.push(`box ${d.id} ${id}`)
        break
      }
      case 'text': {
        const id = some()
        trace.push(`text ${d.id} ${id ?? 'no box'}`)
        if (id === undefined) break
        const token = `${d.id}:${step} `
        editPage(d.local, PAGE, (p) => appendText(p, id, token), nextPeer++)
        edited.boxes.get(id)?.push(token)
        break
      }
      case 'move': {
        const id = some()
        trace.push(`move ${d.id} ${id ?? 'no box'}`)
        if (id !== undefined) editPage(d.local, PAGE, (p) => p.updateBox(id, { y: a.pick * 20 }), nextPeer++)
        break
      }
      case 'del': {
        const id = some()
        if (id === undefined || boxIds().length < 2) break
        trace.push(`del ${d.id} ${id}`)
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

  await quiesce(devices)

  totals.runs++
  if ([...shared.files.keys()].some((path) => path.includes('/snapshot-'))) totals.compacted++
  for (const d of devices) for (const k of FAULT_KINDS) totals.fired[k] += d.drive.fired[k]
  verify(devices, edited)
  return {
    trace,
    devices: devices.map((d) => ({
      docs: [PAGE, NOTEBOOK].map((docId) => d.local.doc(docId).toJSON() as unknown),
      conflicts: d.local.conflicts.map((c) => ({ ...c, at: 0 })),
      restored: d.local.notes.length,
      fired: { ...d.drive.fired }
    })),
    remote: [...shared.files.keys()].sort()
  }
}

export function verify(devices: Dev[], edited: Edited): void {
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
