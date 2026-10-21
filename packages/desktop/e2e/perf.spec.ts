import { expect, test } from './fixtures'

type TestWindow = Window & { slateTest: { seedBoxes(n: number): void; lastPageOpenMs(): number | null }; __keyTimes: number[] }

test('a 200-box page opens in under 100 ms and typing stays under 16 ms per key', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => (window as unknown as TestWindow).slateTest.seedBoxes(200))
  await expect(page.getByTestId('box')).toHaveCount(200)

  await page.getByTestId('add-page').click()
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.getByTestId('page-item').first().click()
  await expect(page.getByTestId('box')).toHaveCount(200)
  const openMs = await page.evaluate(() => (window as unknown as TestWindow).slateTest.lastPageOpenMs())
  console.log(`page open: ${openMs?.toFixed(1)} ms`)
  expect(openMs).not.toBeNull()
  expect(openMs!).toBeLessThan(100)

  await page.getByTestId('box-editor').first().click()
  await page.evaluate(() => {
    const w = window as unknown as TestWindow
    w.__keyTimes = []
    window.addEventListener(
      'keydown',
      () => {
        const t0 = performance.now()
        setTimeout(() => w.__keyTimes.push(performance.now() - t0), 0)
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
  console.log(`keystroke p50 ${sorted[Math.floor(sorted.length * 0.5)].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms over ${times.length} keys`)
  expect(p95).toBeLessThan(16)
})
