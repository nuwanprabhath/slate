import type { CDPSession, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Where typing time goes, for a machine where perf.spec.ts is slow. Off unless SLATE_PERF_TRACE=1:
// it prints a summary (trace events on the renderer main thread, hottest JS functions) rather than
// asserting anything.
test.skip(!process.env.SLATE_PERF_TRACE, 'diagnostic: set SLATE_PERF_TRACE=1')

type TestWindow = Window & { slateTest: { seedBoxes(n: number): void }; __keyTimes: number[] }

const TEXT = 'the quick brown fox jumps over the lazy dog '.repeat(2)

async function timeTyping(page: Page): Promise<string> {
  await page.evaluate(() => {
    const w = window as unknown as TestWindow
    w.__keyTimes = []
    const channel = new MessageChannel()
    const starts: number[] = []
    channel.port1.onmessage = () => w.__keyTimes.push(performance.now() - starts.shift()!)
    window.addEventListener('keydown', () => {
      starts.push(performance.now())
      channel.port2.postMessage(null)
    }, { capture: true })
  })
  await page.keyboard.type(TEXT, { delay: 30 })
  const times = await page.evaluate(() => (window as unknown as TestWindow).__keyTimes)
  const s = [...times].sort((a, b) => a - b)
  return `p50 ${s[Math.floor(s.length / 2)]?.toFixed(1)} ms, p95 ${s[Math.floor(s.length * 0.95)]?.toFixed(1)} ms over ${s.length} keys`
}

interface TraceEvent { name: string; ph: string; dur?: number; tid: number; pid: number; args?: { name?: string } }

async function traced(cdp: CDPSession, run: () => Promise<void>): Promise<TraceEvent[]> {
  const events: TraceEvent[] = []
  cdp.on('Tracing.dataCollected', (e) => events.push(...(e.value as unknown as TraceEvent[])))
  const done = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()))
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink,cc,gpu,toplevel,v8', transferMode: 'ReportEvents' })
  await run()
  await cdp.send('Tracing.end')
  await done
  return events
}

function summarise(events: TraceEvent[]): string {
  const threads = new Map<string, string>()
  for (const e of events) if (e.name === 'thread_name' && e.args?.name) threads.set(`${e.pid}:${e.tid}`, e.args.name)
  const totals = new Map<string, { ms: number; n: number }>()
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue
    const key = `${threads.get(`${e.pid}:${e.tid}`) ?? `tid ${e.tid}`} | ${e.name}`
    const t = totals.get(key) ?? { ms: 0, n: 0 }
    t.ms += e.dur / 1000
    t.n++
    totals.set(key, t)
  }
  return [...totals].sort((a, b) => b[1].ms - a[1].ms).slice(0, 30).map(([k, t]) => `${t.ms.toFixed(0).padStart(7)} ms ${String(t.n).padStart(6)}x  ${k}`).join('\n')
}

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }

function hottest(profile: { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] }): string {
  const self = new Map<string, number>()
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  profile.samples?.forEach((id, i) => {
    const f = byId.get(id)!.callFrame
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000)
  })
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => `${ms.toFixed(0).padStart(7)} ms  ${k}`).join('\n')
}

test('diagnose typing latency', async ({ page }) => {
  test.setTimeout(180_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  const info = await page.evaluate(() => ({ visibility: document.visibilityState, hasFocus: document.hasFocus(), dpr: devicePixelRatio, ua: navigator.userAgent }))
  console.log('[diag] page', JSON.stringify(info))
  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl')
    const ext = c?.getExtension('WEBGL_debug_renderer_info')
    return ext ? c!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no webgl'
  })
  console.log('[diag] gpu', gpu)

  // One box on the page: the per-key floor without a large page to lay out.
  await page.getByTestId('canvas').dblclick({ position: { x: 100, y: 100 } })
  console.log('[diag] 1 box:', await timeTyping(page))

  await page.getByTestId('add-page').click()
  await page.evaluate(() => (window as unknown as TestWindow).slateTest.seedBoxes(200))
  await expect(page.getByTestId('box')).toHaveCount(200)
  await page.getByTestId('box-editor').first().click()

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  let latency = ''
  const events = await traced(cdp, async () => {
    latency = await timeTyping(page)
  })
  const { profile } = (await cdp.send('Profiler.stop')) as { profile: Parameters<typeof hottest>[0] }
  console.log('[diag] 200 boxes:', latency)
  console.log(`[diag] trace, top events by total time:\n${summarise(events)}`)
  console.log(`[diag] JS self time, hottest functions:\n${hottest(profile)}`)
})
