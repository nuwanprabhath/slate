import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The budgets are for a real machine. CI sets SLATE_PERF_FACTOR for its shared, GPU-less VM (page
// open measured 124 ms there against well under 100 ms on a laptop), so large regressions still fail.
const factor = Number(process.env.SLATE_PERF_FACTOR) || 1

type TestWindow = Window & { slateTest: { seedBoxes(n: number): void; lastPageOpenMs(): number | null }; __keyTimes: number[] }

async function measure(page: Page, label: string) {
  await page.evaluate(() => (window as unknown as TestWindow).slateTest.seedBoxes(200))
  await expect(page.getByTestId('box')).toHaveCount(200)

  await page.getByTestId('add-page').click()
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.getByTestId('page-item').first().click()
  await expect(page.getByTestId('box')).toHaveCount(200)
  const openMs = await page.evaluate(() => (window as unknown as TestWindow).slateTest.lastPageOpenMs())
  console.log(`${label} page open: ${openMs?.toFixed(1)} ms`)
  expect(openMs).not.toBeNull()
  expect(openMs!).toBeLessThan(100 * factor)

  await page.getByTestId('box-editor').first().click()
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
  // Enough keys that p95 is not decided by one GC pause or paint frame (with 54 keys it was the
  // third-slowest sample, and runs swung 8-18 ms around a 5 ms median).
  await page.keyboard.type('the quick brown fox jumps over the lazy dog 0123456789 '.repeat(5), { delay: 30 })
  const times = await page.evaluate(() => (window as unknown as TestWindow).__keyTimes)
  const sorted = [...times].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  console.log(`${label} keystroke p50 ${sorted[Math.floor(sorted.length * 0.5)].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms over ${times.length} keys`)
  expect(p95).toBeLessThan(16 * factor)
}

test('a 200-box page opens in under 100 ms and typing stays under 16 ms per key', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await measure(page, 'Dark')
})

test('the same budgets hold with the Glass theme and its animated backdrop', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => window.slate.settings.set({ themeId: 'builtin:glass', motion: 'full' }))
  await expect(page.locator('html')).toHaveAttribute('data-material', 'glass')
  await expect(page.getByTestId('theme-effects')).toHaveAttribute('data-frames', /\d+/)
  await measure(page, 'Glass')
})
