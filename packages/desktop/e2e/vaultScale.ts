// Measurement for the vault-scale responsiveness probe (perf-vault-scale.spec.ts, review finding F3).
//
// F3: every sync run loads and decodes EVERY document in the vault to compare version vectors
// (`packages/sync/src/engine.ts` iterates `this.local.docIds()`, which is `store.list('')` in
// `main/sync/localStore.ts`). The local-store adapter wraps synchronous SQLite calls in `async`, so the
// scan yields only to microtasks: it is one uninterrupted task on the main process's event loop.
// Syncs run every 30 s and 2 s after each edit burst, so the stall is not rare.
//
// Measured on `main`, the renderer keeps up: typing is local to it and stays inside the budget. What stops is
// the main process, and with it everything the renderer asks of it (saving, opening a page, search, images).
// That is why the round-trip check below is the one that catches F3, and the key-latency check is kept as the
// guard that B3 does not move the cost into the renderer instead.
//
// What this file measures, while a sync run is in progress:
// - key latency, key-down to the next free task, against the product budget (CLAUDE.md "Performance budget");
// - main-thread responsiveness, as the round-trip time of `window.slate.appVersion()` sampled every 50 ms.
//   appVersion does no work: its round trip is the time main took to get to the call, so a scan that holds
//   the thread shows up there and nowhere else.
import type { Page } from '@playwright/test'
import { expect } from './fixtures'
import { percentile, settle } from './perfCpu'
import { BUDGET } from './spec/perfMeasure'

/** No round trip to an idle main process may take longer than this (the brief's bar for "responsive"). */
export const ROUND_TRIP_MS = 100

const TEXT = 'the quick brown fox jumps over the lazy dog 0123456789 '

type Probe = {
  __keyTimes: number[]
  __rt: { ms: number; at: number }[]
  __stop: boolean
  __syncStates: { state: string; at: number }[]
  /** Every status the main process pushed during the measurement, so the run's own counts can be read back. */
  __reports: { status: string; pushed: number; pulled: number; at: number }[]
  /** Set once the listeners are on, so a second case resets the samples without stacking a second of each. */
  __installed: boolean
}

type ProbeWindow = Window & Probe & { slateTest: { seedBoxes(n: number): void } }

/**
 * Copies one real page's Loro updates under `pages` fresh document ids, so the vault holds that many documents
 * the sync scan must load and decode. Real snapshot bytes, not synthetic ones: the decode cost is the product's.
 * Returns how long the seeding itself took, which the spec reports (it is the expensive part of the test).
 */
export async function seedPages(page: Page, pages: number): Promise<{ seedMs: number; docs: number }> {
  await page.evaluate(() => (window as unknown as ProbeWindow).slateTest.seedBoxes(20))
  await expect(page.getByTestId('box')).toHaveCount(20)
  // The open page persists its boxes through docs.append; seeding copies whatever has landed by then.
  const pageId = await pollForPersistedPage(page)

  const seedMs = await page.evaluate(
    async ({ pageId: id, pages: n }) => {
      const parts = await window.slate.docs.load(id)
      if (parts.length === 0) throw new Error(`the page to copy has no updates: ${id}`)
      const t0 = performance.now()
      for (let i = 0; i < n; i++) {
        // `docs:append` refuses anything but `page:<uuid>` (shared/ipcValidators.ts), so the seeds are
        // counted off inside one UUID shape rather than named.
        const docId = `page:d4d4d4d4-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
        for (const part of parts) await window.slate.docs.append(docId, part)
      }
      return performance.now() - t0
    },
    { pageId, pages },
  )
  const docs = await page.evaluate(() => window.slate.docs.list('').then((ids) => ids.length))
  return { seedMs, docs }
}

/**
 * Polls until no sync run is in flight and returns the status it ended on.
 *
 * "Not in flight" means three consecutive non-`syncing` statuses a second apart, read from the main process
 * rather than the toolbar button. One reading is not enough: `now()` in `main/sync/syncService.ts` remembers a
 * sync asked for during a run and starts exactly one more the moment it ends, and the status says `idle-synced`
 * in the millisecond gap between the two. A single reading lands in that gap and reports a first sync still
 * pushing hundreds of documents as finished — which is what made this probe measure the first sync while
 * believing it measured the steady state (report-D4B.md).
 */
export async function runEnded(page: Page, timeout: number): Promise<string> {
  let last = 'syncing'
  let notSyncing = 0
  await expect
    .poll(
      async () => {
        last = await page.evaluate(() => window.slate.sync.status().then((s) => s.status))
        notSyncing = last === 'syncing' ? 0 : notSyncing + 1
        return notSyncing >= 3
      },
      { timeout, intervals: [1_000] },
    )
    .toBe(true)
  return last
}

/**
 * Waits for a sync run to finish successfully, clicking again if it failed.
 *
 * On a loaded machine two runs can overlap on one git clone and lose the race for `index.lock` (`error`), and a
 * local git command over thousands of files can outrun `LOCAL_TIMEOUT_MS`, be SIGKILLed and come back as
 * `offline` (`gitError` in `packages/sync/src/gitDrive.ts`). Both are retried; a setup that cannot sync at all
 * fails here by name instead of as a bare predicate timeout.
 */
export async function settled(page: Page, timeout: number): Promise<void> {
  // After an edit burst the next run starts on a 2 s timer (AFTER_EDIT_MS), so a status read straight after
  // seeding still says idle-synced and would report a sync that has not begun as already finished.
  await page.waitForTimeout(3_000)
  const deadline = Date.now() + timeout
  const tried: string[] = []
  for (let attempt = 0; attempt < 4; attempt++) {
    const status = await runEnded(page, Math.max(5_000, deadline - Date.now()))
    if (status === 'idle-synced') return
    tried.push(status)
    await page.getByTestId('sync-status').click()
  }
  expect(tried.join(', '), 'a sync run that ends in idle-synced (four runs in a row failed)').toBe('idle-synced')
}

async function pollForPersistedPage(page: Page): Promise<string> {
  let pageId = ''
  await expect
    .poll(
      async () => {
        const ids = await page.evaluate(() => window.slate.docs.list('page:'))
        for (const id of ids) {
          const bytes = await page.evaluate((d) => window.slate.docs.load(d).then((p) => p.reduce((n, u) => n + u.length, 0)), id)
          // A page with 20 seeded boxes is several KiB; an empty one is a few hundred bytes.
          if (bytes > 4_000) {
            pageId = id
            return true
          }
        }
        return false
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true)
  return pageId
}

/**
 * Records key-down to the next free task, main round trips every 50 ms, the sync button's state changes and
 * every status the main process pushes. Called once per measured case: the samples are cleared each time, the
 * listeners are added only the first time (a second keydown listener would count every key twice).
 */
async function installProbes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow
    w.__keyTimes = []
    w.__rt = []
    w.__stop = false
    w.__syncStates = []
    w.__reports = []

    const sample = () => {
      void (async () => {
        while (!w.__stop) {
          const t0 = performance.now()
          await window.slate.appVersion()
          w.__rt.push({ ms: performance.now() - t0, at: t0 })
          await new Promise((r) => setTimeout(r, 50))
        }
      })()
    }
    if (w.__installed) {
      w.__syncStates.push({ state: document.querySelector('[data-testid="sync-status"]')?.getAttribute('data-state') ?? '?', at: performance.now() })
      sample()
      return
    }
    w.__installed = true
    window.slate.sync.onStatus((s) => w.__reports.push({ status: s.status, pushed: s.pushed, pulled: s.pulled, at: s.at }))

    // A MessageChannel task runs as soon as the main thread is free after the key; setTimeout is clamped
    // in a window that was never shown, which would measure the clamp (see spec/perfMeasure.ts).
    const channel = new MessageChannel()
    const starts: number[] = []
    channel.port1.onmessage = () => w.__keyTimes.push(performance.now() - starts.shift()!)
    window.addEventListener(
      'keydown',
      () => {
        starts.push(performance.now())
        channel.port2.postMessage(null)
      },
      { capture: true },
    )

    const button = document.querySelector('[data-testid="sync-status"]')
    if (!button) throw new Error('no sync status button to watch')
    const note = () => w.__syncStates.push({ state: button.getAttribute('data-state') ?? '?', at: performance.now() })
    note()
    new MutationObserver(note).observe(button, { attributes: true, attributeFilter: ['data-state'] })
    sample()
  })
}

/** The last run's report, as the renderer sees it: how many documents that run pushed and pulled. */
export async function syncCounts(page: Page): Promise<Run> {
  return page.evaluate(() => window.slate.sync.status().then((s) => ({ pushed: s.pushed, pulled: s.pulled, status: s.status, at: s.at })))
}

/** One sync run as the main process reported it. `at` is main's own `Date.now()` when the run finished. */
export type Run = { pushed: number; pulled: number; status: string; at: number }

/**
 * The heaviest run that FINISHED inside the measurement window.
 *
 * Only `idle-synced` reports are counted. A run announces its start by re-sending the previous run's counts
 * with the status `syncing` (`setReport` in `main/sync/syncService.ts`), so a steady-state run's first event
 * still carries the first sync's 500; and a run the service queued behind the measured one finishes last, so a
 * single read at the end can report its handful of documents instead. The largest completed run is the one the
 * stall belongs to.
 */
function heaviestRun(reports: { status: string; pushed: number; pulled: number; at: number }[], fallback: Run): Run {
  const done = reports.filter((r) => r.status === 'idle-synced')
  if (done.length === 0) return fallback
  return done.reduce((best, r) => (r.pushed > best.pushed ? r : best))
}

export type Measured = {
  keys: { p50: number; p95: number; max: number; count: number }
  roundTrips: { p50: number; p95: number; max: number; count: number; spacingMs: number }
  syncStates: string[]
  /** Proved from main's own clock, not from the toolbar: the measured run was in flight while keys went in. */
  overlapped: boolean
  /** Wall-clock ms by which the measured run outlasted the first key. */
  ranPastFirstKeyMs: number
  report: Run
  /** The status the measured run ended on. Anything but `idle-synced` means the run did not get through. */
  outcome: string
}

/**
 * How the sync run being measured is started. `click` presses the toolbar button, which runs the same
 * `syncOnce` as the timer and saves the test a 30 s wait. `edit-timer` starts nothing and lets the run the
 * seeding already scheduled (AFTER_EDIT_MS, 2 s) begin inside the typing window: that is the only way to be
 * inside the FIRST sync of a freshly seeded vault, because the toolbar click is a no-op while one is running
 * (`syncNow` returns early when busy, `SyncStatus.tsx`).
 */
export type Start = 'click' | 'edit-timer'

/**
 * Types through one sync run and reports both measurements.
 *
 * Round trips keep being sampled until the run has finished, not only while keys are going in: the first sync
 * of a large vault outlasts the typing, and a sampler stopped at the last key reports a stall shorter than the
 * one the user sits through. Key latency is still only the typing window, which is what the budget is about.
 */
export async function measureDuringSync(page: Page, start: Start): Promise<Measured> {
  // `edit-timer` attaches the probes first and settles afterwards: the run it measures is already on a 2 s
  // fuse, and settling first can burn it.
  if (start === 'edit-timer') await installProbes(page)
  // A click is a no-op while a run is in flight (`syncNow` returns early when busy, `SyncStatus.tsx`), so the
  // clicked case must start from a finished sync or it would measure whatever was already running.
  if (start === 'click') await settled(page, 900_000)
  const quiet = await settle(page)
  console.log(`settled: idle-task p95 ${quiet.p95.toFixed(1)} ms after ${quiet.waitedMs} ms`)
  if (start === 'click') await installProbes(page)

  await page.getByTestId('box-editor').first().click()
  // Both clocks are this machine's `Date.now()`, so the run's own finish time can be compared with them.
  const armedAt = Date.now()
  if (start === 'click') await page.getByTestId('sync-status').click()

  const firstKeyAt = Date.now()
  await page.keyboard.type(TEXT.repeat(4), { delay: 30 })
  const lastKeyAt = Date.now()

  // Still sampling: this is where a first sync's remaining seconds are caught. The run is only waited out, not
  // required to succeed - a run that fails has still stalled main, and the assertions report the outcome.
  const outcome = await runEnded(page, 900_000)
  const last = await syncCounts(page)

  const raw = await page.evaluate(() => {
    const w = window as unknown as ProbeWindow
    w.__stop = true
    return { keys: w.__keyTimes, rt: w.__rt, states: w.__syncStates, reports: w.__reports }
  })
  const report = heaviestRun(raw.reports, last)

  // Overlap is decided by when the measured run FINISHED, on main's clock, against when the first key went in.
  //
  // The toolbar's `data-state` cannot answer this: the renderer learns a run has started from an IPC status
  // event, and a run that blocks main blocks that event too, so at 2,000 pages the `syncing` state was recorded
  // only after the typing was over - a 63.9 s stall that spanned every key looked like no overlap at all
  // (report-D4B.md). The run was started before the first key (`armedAt`) and finished after it, so it was in
  // flight throughout; `syncStates` is kept for the log, not for the verdict.
  const ranPastFirstKeyMs = report.at - firstKeyAt
  const overlapped = armedAt <= report.at && report.at > firstKeyAt && armedAt < lastKeyAt

  const rtMs = raw.rt.map((r) => r.ms)
  const spacing = raw.rt.length > 1 ? (raw.rt[raw.rt.length - 1]!.at - raw.rt[0]!.at) / (raw.rt.length - 1) : 0
  return {
    keys: { p50: percentile(raw.keys, 0.5), p95: percentile(raw.keys, 0.95), max: Math.max(...raw.keys), count: raw.keys.length },
    roundTrips: { p50: percentile(rtMs, 0.5), p95: percentile(rtMs, 0.95), max: Math.max(...rtMs), count: rtMs.length, spacingMs: spacing },
    syncStates: raw.states.map((s) => s.state),
    overlapped,
    ranPastFirstKeyMs,
    report,
    outcome,
  }
}

/**
 * What a FIRST sync against a new remote may cost, in ms of main-process stall, for a vault of `pages`.
 *
 * This is not a budget: it is a tripwire well above measured reality (4.5-5.8 s at 500 pages, 61.9 s at 2,000
 * on a loaded Mac), so the known limitation in report-D4B.md cannot get an order of magnitude worse unnoticed.
 * The number the limitation is written from is the one the run logs, not this ceiling. It is per page because
 * the stall grows faster than the vault: about 11 ms a page at 500 and about 31 ms at 2,000.
 */
export const firstSyncCeilingMs = (pages: number): number => pages * 60

/** Prints the measurement. Every case logs through this, so a report can quote the run it came from. */
function report(m: Measured, pages: number, what: string): void {
  console.log(
    `${String(pages)} pages, ${what}: key latency p50 ${m.keys.p50.toFixed(1)} ms, p95 ${m.keys.p95.toFixed(1)} ms, max ${m.keys.max.toFixed(1)} ms over ${String(m.keys.count)} keys`,
  )
  console.log(
    `${String(pages)} pages, ${what}: appVersion round trip p50 ${m.roundTrips.p50.toFixed(1)} ms, p95 ${m.roundTrips.p95.toFixed(1)} ms, max ${m.roundTrips.max.toFixed(1)} ms over ${String(m.roundTrips.count)} samples ${m.roundTrips.spacingMs.toFixed(0)} ms apart; the run pushed ${String(m.report.pushed)} and pulled ${String(m.report.pulled)} documents; the run ended ${m.outcome} ${(m.ranPastFirstKeyMs / 1000).toFixed(1)} s after the first key; sync states ${m.syncStates.join(' → ')}`,
  )
}

/** Every case asserts this first: a measurement no sync overlapped, or one whose run never got through, measures nothing. */
function assertOverlapped(m: Measured): void {
  expect(m.overlapped, 'the measured sync run was in flight while the keys went in (otherwise this measures nothing)').toBe(true)
  expect(m.outcome, 'the status the measured sync run ended on').toBe('idle-synced')
}

/** Typing must stay inside the product budget whichever run overlaps it: B3 must not move the cost here. */
function assertKeysWithinBudget(m: Measured, pages: number): void {
  expect(m.keys.p50, `wall-clock median per key with ${String(pages)} pages in the vault, ms`).toBeLessThan(BUDGET.keyMedian)
  expect(m.keys.p95, `wall-clock p95 per key (two frames) with ${String(pages)} pages in the vault, ms`).toBeLessThan(BUDGET.keyTail)
}

/** The steady state, which B3 makes cheap: the run touches only what changed, so main stays answerable. */
export function assertResponsive(m: Measured, pages: number): void {
  report(m, pages, 'during a steady-state sync')
  assertOverlapped(m)
  // A run that pushed every document is a first sync, not the steady state: it would pass the bar only by
  // measuring a window the scan happened to miss.
  expect(m.report.pushed, 'documents the measured steady-state run pushed (a full scan means the setup leaked a first sync into the measurement)').toBeLessThan(pages)
  assertKeysWithinBudget(m, pages)
  expect(m.roundTrips.max, `slowest appVersion round trip while a steady-state sync ran over ${String(pages)} documents, ms`).toBeLessThan(ROUND_TRIP_MS)
}

/**
 * The first sync against a new remote, which must scan every document and blocks main for seconds. This is a
 * known limitation, measured rather than hidden: the assertion is the tripwire, the log line is the deliverable.
 */
export function assertFirstSyncCost(m: Measured, pages: number): void {
  report(m, pages, 'during the FIRST sync against a new remote')
  assertOverlapped(m)
  expect(m.report.pushed, 'documents the first sync pushed (it must be the full scan, or this measures the wrong run)').toBeGreaterThanOrEqual(pages)
  assertKeysWithinBudget(m, pages)
  expect(m.roundTrips.max, `slowest appVersion round trip while the FIRST sync scanned ${String(pages)} documents, ms (a known limitation, not a budget)`).toBeLessThan(firstSyncCeilingMs(pages))
}
