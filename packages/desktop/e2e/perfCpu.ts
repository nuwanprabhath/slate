// Load-robust measurement for the performance budget (spec/perfMeasure.ts). A wall-clock latency on a machine
// shared with builds and other Electron apps includes the time the OS kept the renderer off a core, so a busy
// machine fails the budget with no change to Slate. Two measurements that load does not move:
//
// - CPU time. The renderer's main-thread CPU time per keystroke (Chrome's `ThreadTime` metric over the DevTools
//   protocol, in thread ticks) from before the key until the frame that shows it has rendered: the key's handlers,
//   ProseMirror's update, style, layout and paint. The DevTools round trips cost CPU on that thread too, so the
//   same sequence without a key is run first as a baseline in the same process, and its median is subtracted.
// - Best of N. A wall-clock percentile that misses because of a load spike passes on a rerun; one that misses
//   because of a regression misses every time. So a miss is retried, and the best run is what is asserted.
import type { CDPSession, Page } from '@playwright/test'

export async function threadClock(page: Page): Promise<{ cpuMs(): Promise<number>; detach(): Promise<void> }> {
  const cdp: CDPSession = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable', { timeDomain: 'threadTicks' })
  return {
    async cpuMs() {
      const { metrics } = await cdp.send('Performance.getMetrics')
      const t = metrics.find((m) => m.name === 'ThreadTime')
      if (!t) throw new Error('this Chromium reports no ThreadTime metric')
      return t.value * 1000
    },
    async detach() {
      await cdp.detach()
    },
  }
}

/** Resolves after the next frame has rendered: a message posted from rAF runs once that frame's update is done. */
const nextFrame = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => resolve()
          channel.port2.postMessage(null)
        }),
      ),
  )

export const percentile = (xs: readonly number[], p: number): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

/**
 * Main-thread CPU milliseconds for each character of `text` typed into the focused editor, each up to its rendered
 * frame, less the median cost of the measurement itself (a baseline of `baselineRuns` frames with no key). Also the
 * off-CPU wait per key: the wall time of the same span (from this process's clock, less the baseline's) minus its
 * CPU, which is time the renderer thread was blocked or descheduled, not working.
 */
export async function keyCpuTimes(page: Page, text: string, baselineRuns = 30): Promise<{ perKey: number[]; offCpu: number[]; overhead: number }> {
  const clock = await threadClock(page)
  try {
    const baseCpu: number[] = []
    const baseWall: number[] = []
    for (let i = 0; i < baselineRuns; i++) {
      const w0 = performance.now()
      const t0 = await clock.cpuMs()
      await nextFrame(page)
      baseCpu.push((await clock.cpuMs()) - t0)
      baseWall.push(performance.now() - w0)
    }
    const overhead = percentile(baseCpu, 0.5)
    const wallOverhead = percentile(baseWall, 0.5)
    const perKey: number[] = []
    const offCpu: number[] = []
    for (const ch of text) {
      const w0 = performance.now()
      const t0 = await clock.cpuMs()
      await page.keyboard.type(ch)
      await nextFrame(page)
      const cpu = Math.max(0, (await clock.cpuMs()) - t0 - overhead)
      perKey.push(cpu)
      offCpu.push(Math.max(0, performance.now() - w0 - wallOverhead - cpu))
    }
    return { perKey, offCpu, overhead }
  } finally {
    await clock.detach()
  }
}

/** Runs `measure` until `ok` holds, at most `runs` times; returns the best value seen (smallest) and every value. */
export async function bestOf(runs: number, measure: () => Promise<number>, ok: (v: number) => boolean): Promise<{ best: number; all: number[] }> {
  const all: number[] = []
  for (let i = 0; i < runs; i++) {
    all.push(await measure())
    if (ok(all[all.length - 1]!)) break
  }
  return { best: Math.min(...all), all }
}

/**
 * Waits until the renderer's main thread is quiet: 40 probe tasks posted 10 ms apart, the p95 of how late each ran
 * under `quietMs`, or `maxMs` passed. Calibrates the run against this process's own idle baseline, so work the app
 * does after a launch or an unlock (or a load spike) is not measured as the editor's.
 */
export async function settle(page: Page, quietMs = 4, maxMs = 30_000): Promise<{ p95: number; waitedMs: number }> {
  const started = Date.now()
  let p95 = Infinity
  while (Date.now() - started < maxMs) {
    const delays = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const out: number[] = []
          const channel = new MessageChannel()
          let posted = 0
          channel.port1.onmessage = () => {
            out.push(performance.now() - posted)
            if (out.length === 40) resolve(out)
            else setTimeout(() => ((posted = performance.now()), channel.port2.postMessage(null)), 10)
          }
          posted = performance.now()
          channel.port2.postMessage(null)
        }),
    )
    p95 = percentile(delays, 0.95)
    if (p95 < quietMs) break
  }
  return { p95, waitedMs: Date.now() - started }
}
