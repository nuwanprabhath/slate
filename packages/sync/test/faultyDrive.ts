// A RemoteDrive wrapper that injects the faults a real network has, at the Nth call of a plan: a refused call, a
// write that landed but whose answer was lost, a call that never answers (a stall the caller must abort, or a crash
// of the whole process), and delta pages that omit, reorder or repeat items. The wrapper counts every fault that
// actually fired so a test can prove each kind ran.
import { mulberry32 } from './simulation'
import { OfflineError, type DeltaPage, type RemoteDrive } from '../src/types'

/** What can happen to any call. `applied` says whether a stall or crash happens after the call took effect. */
export type CallFault =
  | { kind: 'offline' }
  /** The remote did the work, the answer never arrived: the caller sees OfflineError. */
  | { kind: 'lostAck' }
  /** No answer ever, and the caller is still alive: only its abort signal ends the wait. */
  | { kind: 'stall'; applied: boolean }
  /** No answer ever because the process died: the caller is dropped and a new one starts over the same store. */
  | { kind: 'crash'; applied: boolean }
  /** A write delivered twice (retransmission); reads are unaffected. */
  | { kind: 'dupWrite' }

/** What can happen to a delta page. `salt` seeds which items go and the order they come back in. */
export interface DeltaFault {
  kind: 'omit' | 'reorder' | 'dupDelta'
  salt: number
}

export type FaultKind = CallFault['kind'] | DeltaFault['kind']
export const FAULT_KINDS: readonly FaultKind[] = ['offline', 'lostAck', 'stall', 'crash', 'dupWrite', 'omit', 'reorder', 'dupDelta']

/** `calls` is indexed by the number of the call among all calls on this drive, `deltas` by the number among delta calls. */
export interface FaultPlan {
  calls: Readonly<Record<number, CallFault>>
  deltas: Readonly<Record<number, DeltaFault>>
}

export type HangKind = 'stall' | 'crash'

export interface FaultyDrive extends RemoteDrive {
  /** False once faults must stop (the quiescence phase). */
  enabled: boolean
  readonly fired: Record<FaultKind, number>
  /** Told when a call starts hanging, so the harness can abort (stall) or drop the engine (crash). */
  onHang: ((kind: HangKind) => void) | undefined
}

export const noFaults = (): FaultPlan => ({ calls: {}, deltas: {} })

export function faultyDrive(inner: RemoteDrive, plan: FaultPlan): FaultyDrive {
  let calls = 0
  let deltas = 0
  const drive: FaultyDrive = {
    enabled: true,
    fired: Object.fromEntries(FAULT_KINDS.map((k) => [k, 0])) as Record<FaultKind, number>,
    onHang: undefined,
    upload: (path, bytes, signal) => call(true, () => inner.upload(path, bytes, signal)),
    download: (path, signal) => call(false, () => inner.download(path, signal)),
    remove: (path, signal) => call(true, () => inner.remove(path, signal)),
    delta: (cursor, signal) => {
      const fault = drive.enabled ? plan.deltas[deltas] : undefined
      deltas++
      return call(false, async () => disturb(await inner.delta(cursor, signal), cursor, fault))
    }
  }
  if (inner.flush) {
    const flush = inner.flush.bind(inner)
    drive.flush = (signal) => call(true, () => flush(signal))
  }

  /** Never answers. The caller's `transfer` or the harness's dropped engine is what ends the wait. */
  function hang(kind: HangKind): Promise<never> {
    drive.fired[kind]++
    drive.onHang?.(kind)
    return new Promise<never>(() => {})
  }

  async function call<T>(write: boolean, run: () => Promise<T>): Promise<T> {
    const fault = drive.enabled ? plan.calls[calls] : undefined
    calls++
    if (!fault) return run()
    switch (fault.kind) {
      case 'offline':
        drive.fired.offline++
        throw new OfflineError()
      case 'lostAck':
        await run()
        drive.fired.lostAck++
        throw new OfflineError()
      case 'stall':
      case 'crash':
        if (fault.applied) await run()
        return hang(fault.kind)
      case 'dupWrite': {
        const result = await run()
        if (write) {
          await run()
          drive.fired.dupWrite++
        }
        return result
      }
    }
  }

  function disturb(page: DeltaPage, cursor: string | null, fault: DeltaFault | undefined): DeltaPage {
    if (!fault || page.items.length === 0) return page
    const rand = mulberry32(fault.salt)
    switch (fault.kind) {
      case 'omit': {
        // A page that withholds items and does not move the cursor past them: they arrive on a later poll. (A
        // cursor that skipped them would be a drive that loses changes, which no engine can recover from.) There is
        // no cursor to hold at when listing from scratch.
        if (cursor === null) return page
        const kept = page.items.filter(() => rand() < 0.5)
        if (kept.length === page.items.length) kept.pop()
        drive.fired.omit++
        return { items: kept, cursor }
      }
      case 'reorder': {
        const items = [...page.items]
        for (let i = items.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1))
          ;[items[i], items[j]] = [items[j]!, items[i]!]
        }
        drive.fired.reorder++
        return { items, cursor: page.cursor }
      }
      case 'dupDelta': {
        const again = page.items.filter(() => rand() < 0.7)
        drive.fired.dupDelta++
        return { items: [...page.items, ...again, ...page.items], cursor: page.cursor }
      }
    }
  }

  return drive
}
