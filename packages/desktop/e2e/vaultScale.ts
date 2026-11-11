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
 * Waits until no sync run is in progress. A run that failed is clicked again: on a loaded machine two runs can
 * still overlap on one git clone and lose the race for `index.lock`, which is a transient of the setup, not what
 * this probe measures.
 */
export async function settled(page: Page, timeout: number): Promise<void> {
  const button = page.getByTestId('sync-status')
  // After an edit burst the next run starts on a 2 s timer (AFTER_EDIT_MS), so a state read straight after
  // seeding still says idle-synced and would report a sync that has not begun as already finished.
  await page.waitForTimeout(3_000)
  await expect
    .poll(
      async () => {
        const state = await button.getAttribute('data-state')
        if (state === 'error') await button.click()
        return state
      },
      { timeout, intervals: [500, 1_000, 2_000, 5_000] },
    )
    .toBe('idle-synced')
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

/** Records key-down to the next free task, main round trips every 50 ms, and the sync button's state changes. */
async function installProbes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow
    w.__keyTimes = []
    w.__rt = []
    w.__stop = false
    w.__syncStates = []

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

    void (async () => {
      while (!w.__stop) {
        const t0 = performance.now()
        await window.slate.appVersion()
        w.__rt.push({ ms: performance.now() - t0, at: t0 })
        await new Promise((r) => setTimeout(r, 50))
      }
    })()
  })
}

export type Measured = {
  keys: { p50: number; p95: number; max: number; count: number }
  roundTrips: { p50: number; p95: number; max: number; count: number; spacingMs: number }
  syncStates: string[]
  syncingWhileTyping: boolean
}

/**
 * Starts a sync, then types through it and reports both measurements. The sync is started from the toolbar
 * button rather than waited for on the timer: the same `syncOnce` runs either way, and the test does not have
 * to sit out a 30 s interval.
 */
export async function measureDuringSync(page: Page): Promise<Measured> {
  const quiet = await settle(page)
  console.log(`settled: idle-task p95 ${quiet.p95.toFixed(1)} ms after ${quiet.waitedMs} ms`)

  await installProbes(page)
  await page.getByTestId('box-editor').first().click()

  const button = page.getByTestId('sync-status')
  await button.click()
  const typedFrom = await page.evaluate(() => performance.now())
  await page.keyboard.type(TEXT.repeat(4), { delay: 30 })
  const typedTo = await page.evaluate(() => performance.now())

  const raw = await page.evaluate(() => {
    const w = window as unknown as ProbeWindow
    w.__stop = true
    return { keys: w.__keyTimes, rt: w.__rt, states: w.__syncStates }
  })

  const spans = raw.states.map((s, i) => ({ ...s, until: raw.states[i + 1]?.at ?? Number.POSITIVE_INFINITY }))
  const syncingWhileTyping = spans.some((s) => s.state === 'syncing' && s.until > typedFrom && s.at < typedTo)

  const rtMs = raw.rt.map((r) => r.ms)
  const spacing = raw.rt.length > 1 ? (raw.rt[raw.rt.length - 1]!.at - raw.rt[0]!.at) / (raw.rt.length - 1) : 0
  return {
    keys: { p50: percentile(raw.keys, 0.5), p95: percentile(raw.keys, 0.95), max: Math.max(...raw.keys), count: raw.keys.length },
    roundTrips: { p50: percentile(rtMs, 0.5), p95: percentile(rtMs, 0.95), max: Math.max(...rtMs), count: rtMs.length, spacingMs: spacing },
    syncStates: raw.states.map((s) => s.state),
    syncingWhileTyping,
  }
}

/** Prints the measurement and holds it to the product budget and the round-trip bar. */
export function assertResponsive(m: Measured, pages: number): void {
  console.log(
    `${pages} pages, during sync: key latency p50 ${m.keys.p50.toFixed(1)} ms, p95 ${m.keys.p95.toFixed(1)} ms, max ${m.keys.max.toFixed(1)} ms over ${m.keys.count} keys`,
  )
  console.log(
    `${pages} pages, during sync: appVersion round trip p50 ${m.roundTrips.p50.toFixed(1)} ms, p95 ${m.roundTrips.p95.toFixed(1)} ms, max ${m.roundTrips.max.toFixed(1)} ms over ${m.roundTrips.count} samples ${m.roundTrips.spacingMs.toFixed(0)} ms apart; sync states ${m.syncStates.join(' → ')}`,
  )
  expect(m.syncingWhileTyping, 'a sync run overlapped the typing (otherwise this measures nothing)').toBe(true)
  expect(m.keys.p50, `wall-clock median per key with ${String(pages)} pages in the vault, ms`).toBeLessThan(BUDGET.keyMedian)
  expect(m.keys.p95, `wall-clock p95 per key (two frames) with ${String(pages)} pages in the vault, ms`).toBeLessThan(BUDGET.keyTail)
  expect(m.roundTrips.max, `slowest appVersion round trip while a sync scanned ${String(pages)} documents, ms`).toBeLessThan(ROUND_TRIP_MS)
}
