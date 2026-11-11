import type { LoroDoc, VersionVector } from 'loro-crdt'

/** How a document's stored copy stands against the one on screen. */
export type SaveState = 'saved' | 'saving' | 'unsaved'

/** Where a queue writes. `window.slate.docs` and `DocPersistence` both satisfy it. */
export interface SaveSink {
  append(docId: string, update: Uint8Array): Promise<void>
}

const FIRST_RETRY_MS = 250
const MAX_RETRY_MS = 5000
/**
 * How long `idle()` waits before giving up. The vault flush handshake blocks the lock on it, so a
 * store that keeps rejecting must not hold the window open: the queue keeps retrying either way.
 */
const IDLE_TIMEOUT_MS = 2000

/** Worst first: an aggregate state is the worst of its queues'. */
const SEVERITY: Record<SaveState, number> = { saved: 0, saving: 1, unsaved: 2 }

const live = new Set<SaveQueue>()
const watchers = new Set<() => void>()

function notify(): void {
  watchers.forEach((w) => w())
}

/**
 * Every open document's save state in one place, so the window can say "not saved" wherever the
 * failing edit was made.
 */
export const saveStatus = {
  state: (): SaveState => {
    let worst: SaveState = 'saved'
    for (const q of live) if (SEVERITY[q.state] > SEVERITY[worst]) worst = q.state
    return worst
  },
  error: (): string | undefined => {
    for (const q of live) if (q.state === 'unsaved' && q.error !== undefined) return q.error
    return undefined
  },
  subscribe: (listener: () => void): (() => void) => {
    watchers.add(listener)
    return () => {
      watchers.delete(listener)
    }
  },
}

/** Waits until every open document's queue has nothing left to write (or `idle` gave up). */
export async function allSavesIdle(timeoutMs = IDLE_TIMEOUT_MS): Promise<void> {
  await Promise.all([...live].map((q) => q.idle(timeoutMs)))
}

/**
 * The writes for one Loro document, acknowledged. Loro updates are incremental, so a dropped append
 * makes every later one unloadable (F1): the queue therefore exports from `acked`, the version the
 * store has confirmed, and advances it only once `append` resolved. Flushes are serialised, so a
 * later export always covers an earlier failure and no stored update depends on a missing one.
 */
export class SaveQueue {
  private acked: VersionVector
  private pending = false
  private running: Promise<void> | null = null
  private closed = false
  private retryMs = FIRST_RETRY_MS
  private current: SaveState = 'saved'
  private errorText: string | undefined
  /** Ends the backoff sleep early: a fresh edit (or close) retries at once. */
  private wake: (() => void) | undefined
  private idleWaiters = new Set<() => void>()
  private readonly unsubscribe: () => void

  constructor(
    private readonly docId: string,
    private readonly doc: LoroDoc,
    private readonly sink: SaveSink,
  ) {
    this.acked = doc.oplogVersion()
    live.add(this)
    this.unsubscribe = doc.subscribeLocalUpdates(() => this.schedule())
  }

  get state(): SaveState {
    return this.current
  }

  /** Why the last flush was rejected, while the state is `unsaved`. */
  get error(): string | undefined {
    return this.errorText
  }

  /**
   * A local commit happened (the constructor's subscription calls this). The flush runs on a later
   * microtask, so a burst of commits becomes one export and nothing re-enters Loro's callback.
   */
  private schedule(): void {
    if (this.closed) return
    this.pending = true
    this.setState('saving')
    this.wake?.()
    this.start()
  }

  private start(): void {
    if (this.running) return
    this.running = (async () => {
      await Promise.resolve()
      await this.flushAll()
    })().finally(() => {
      this.running = null
      // A commit that arrived while this flush was finishing must not be left unscheduled: `start`
      // declines while `running` is set, so the restart has to happen here. Losing it would be the
      // very defect this queue exists to close (F1).
      if (this.pending && !this.closed) {
        this.start()
        return
      }
      this.releaseIdle()
    })
  }

  private async flushAll(): Promise<void> {
    while (this.pending) {
      this.pending = false
      this.doc.commit()
      const to = this.doc.oplogVersion()
      const update = this.doc.export({ mode: 'update', from: this.acked })
      if (update.length === 0) break
      try {
        await this.sink.append(this.docId, update)
        this.acked = to
        this.retryMs = FIRST_RETRY_MS
      } catch (e) {
        this.errorText = e instanceof Error ? e.message : String(e)
        this.setState('unsaved')
        this.pending = true
        if (this.closed) break
        await this.sleep(this.retryMs)
        this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
      }
    }
    if (this.pending) return
    this.errorText = undefined
    this.setState('saved')
  }

  /** Resolves once nothing is left to write, or after `timeoutMs` if the store keeps rejecting. */
  async idle(timeoutMs = IDLE_TIMEOUT_MS): Promise<void> {
    if (!this.running && !this.pending) return
    let waiter: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      waiter = resolve
      this.idleWaiters.add(resolve)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))])
    } finally {
      clearTimeout(timer)
      this.idleWaiters.delete(waiter)
    }
  }

  /** Stops retrying and leaves the aggregate state; a flush already under way still finishes. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    live.delete(this)
    this.wake?.()
    // A commit this queue has not written yet gets its one attempt, so closing a page view (or
    // switching page) never drops the edit that was just made.
    if (this.pending) this.start()
    notify()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  private setState(state: SaveState): void {
    if (this.current === state) return
    this.current = state
    notify()
  }

  private releaseIdle(): void {
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    waiters.forEach((w) => w())
  }
}
