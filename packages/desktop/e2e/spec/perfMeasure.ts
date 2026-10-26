// @product-rule performance-budget (CLAUDE.md, Product rules). A guarded spec: its expectations only grow, and only the maintainer changes the rule.
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { bestOf, keyCpuTimes, percentile, settle } from '../perfCpu'

// The budgets are for a real machine. CI sets SLATE_PERF_FACTOR for its shared, GPU-less VM (page
// open measured 124 ms there against well under 100 ms on a laptop), so large regressions still fail.
export const factor = Number(process.env.SLATE_PERF_FACTOR) || 1

/** The budgets as asserted on this machine, in ms (perfProbes.spec.ts sizes its slowdowns from them). */
export const BUDGET = { pageOpen: 100 * factor, keyCpu: 16 * factor, keyMedian: 16 * factor, keyTail: 33 * factor }

/**
 * How the budgets are measured so that a busy machine does not fail them (C11; method in e2e/perfCpu.ts):
 * - Page open, wall clock: the app's own measure from the click to 200 boxes rendered. A miss is retried, up to
 *   3 opens, and the best is asserted: a load spike passes on a retry, a regression misses every time.
 * - Keystrokes, wall clock: key-down to the next task over 275 keys typed at 30 ms, best of up to 3 runs: the
 *   median under 16 ms, and the p95 under two frames (33 ms). A hidden e2e window puts some keys one frame late
 *   (p95 8.6 or 17.8 ms minutes apart at a steady 3 ms CPU a key), so the tail is held to two frames: a key that
 *   blocks off-CPU (a synchronous IPC, a lock) shows there and nowhere else (review C11: 40 ms every 4th key gave
 *   p95 45 ms). spec/perfProbes.spec.ts proves each check fails on the slowness it is for.
 * - First the renderer settles: until an idle probe's task delay is low, start-up work (after a launch or an
 *   unlock) is not timed as typing.
 * - Keystrokes, CPU: the renderer main thread's CPU time per key up to its rendered frame, p95: the work a key
 *   costs, which is what the 16 ms budget is about. Load does not move it, so it is held to the budget on every run.
 */
const RETRIES = 3

type TestWindow = Window & { slateTest: { seedBoxes(n: number): void; lastPageOpenMs(): number | null }; __keyTimes: number[] }

const TEXT = 'the quick brown fox jumps over the lazy dog 0123456789 '

async function openOnce(page: Page): Promise<number> {
  await page.getByTestId('add-page').click()
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.getByTestId('page-item').first().click()
  await expect(page.getByTestId('box')).toHaveCount(200)
  const openMs = await page.evaluate(() => (window as unknown as TestWindow).slateTest.lastPageOpenMs())
  expect(openMs).not.toBeNull()
  return openMs!
}

/** Records key-down to the next free task for every key from now on (installed once: listeners would stack). */
async function recordKeyLatency(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as TestWindow
    w.__keyTimes = []
    // A MessageChannel task runs as soon as the main thread is free after the key. setTimeout is
    // clamped to about 1 s in a window that was never shown (Linux e2e under xvfb), which measured
    // the clamp, not the editor: p50 489 ms there against 7 ms on a laptop.
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
  })
}

async function typingRun(page: Page, label: string): Promise<{ p50: number; p95: number }> {
  await page.getByTestId('box-editor').first().click()
  await page.evaluate(() => {
    ;(window as unknown as TestWindow).__keyTimes = []
  })
  // Enough keys that p95 is not decided by one GC pause or paint frame (with 54 keys it was the
  // third-slowest sample, and runs swung 8-18 ms around a 5 ms median).
  await page.keyboard.type(TEXT.repeat(5), { delay: 30 })
  const times = await page.evaluate(() => {
    const w = window as unknown as TestWindow
    const out = w.__keyTimes
    w.__keyTimes = []
    return out
  })
  const p95 = percentile(times, 0.95)
  console.log(`${label} keystroke p50 ${percentile(times, 0.5).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms over ${times.length} keys`)
  return { p50: percentile(times, 0.5), p95: p95 }
}

export async function measure(page: Page, label: string) {
  // Up to three typing runs and the CPU pass: about 45 s when every retry is needed.
  test.setTimeout(150_000)
  await page.evaluate(() => (window as unknown as TestWindow).slateTest.seedBoxes(200))
  await expect(page.getByTestId('box')).toHaveCount(200)
  // Right after a launch or an unlock the renderer is still busy with start-up work; measuring then times that.
  const quiet = await settle(page)
  console.log(`${label} renderer settled: idle-task p95 ${quiet.p95.toFixed(1)} ms after ${quiet.waitedMs} ms`)

  const open = await bestOf(RETRIES, () => openOnce(page), (ms) => ms < BUDGET.pageOpen)
  console.log(`${label} page open: ${open.best.toFixed(1)} ms (runs: ${open.all.map((v) => v.toFixed(1)).join(', ')})`)
  expect(open.best).toBeLessThan(BUDGET.pageOpen)

  // CPU first: it is what load does not move, and it is printed even when the wall-clock measure then misses.
  await page.getByTestId('box-editor').first().click()
  const cpu = await keyCpuTimes(page, TEXT.repeat(2))
  const cpuP95 = percentile(cpu.perKey, 0.95)
  console.log(`${label} keystroke CPU p50 ${percentile(cpu.perKey, 0.5).toFixed(1)} ms, p95 ${cpuP95.toFixed(1)} ms over ${cpu.perKey.length} keys (measurement overhead ${cpu.overhead.toFixed(2)} ms subtracted); off-CPU wait p50 ${percentile(cpu.offCpu, 0.5).toFixed(1)} ms, p95 ${percentile(cpu.offCpu, 0.95).toFixed(1)} ms, max ${Math.max(...cpu.offCpu).toFixed(1)} ms`)
  expect(cpuP95).toBeLessThan(BUDGET.keyCpu)

  await recordKeyLatency(page)
  // Best of up to three runs, scored by the worse of the two checks against its limit.
  const runs: { p50: number; p95: number }[] = []
  const score = (r: { p50: number; p95: number }) => Math.max(r.p50 / BUDGET.keyMedian, r.p95 / BUDGET.keyTail)
  await bestOf(RETRIES, async () => {
    runs.push(await typingRun(page, label))
    return score(runs[runs.length - 1]!)
  }, (v) => v < 1)
  const best = runs.reduce((a, b) => (score(b) < score(a) ? b : a))
  expect(best.p50, 'wall-clock median per key, ms').toBeLessThan(BUDGET.keyMedian)
  expect(best.p95, 'wall-clock p95 per key (two frames), ms').toBeLessThan(BUDGET.keyTail)
}
