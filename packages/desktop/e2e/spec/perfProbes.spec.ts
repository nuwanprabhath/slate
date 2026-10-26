// @product-rule performance-budget (CLAUDE.md, Product rules). A guarded spec: its expectations only grow, and only the maintainer changes the rule.
// Mutation tests for the measurement itself (review C11): each probe makes the app slow in one way a regression
// could, and `measure()` must fail on it. If one of these passes, the budget stopped seeing that kind of slowness.
import { stripVTControlCharacters } from 'node:util'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { BUDGET, factor, measure } from './perfMeasure'

// Each slowdown is named for the reference machine and scaled by the factor the budgets are (SLATE_PERF_FACTOR on
// CI), so it stays as far over its budget on every machine: unscaled, CI's 40 ms stall fit its 49.5 ms tail budget.
const scaled = (ms: number) => ms * factor

/** Runs `measure()` and returns the budget assertion it failed on; fails the probe if it passed or broke otherwise. */
async function failsBudget(page: Page): Promise<string> {
  let message = ''
  try {
    await measure(page, 'Probe')
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  expect(message, 'measure() passed on a deliberately slow app').not.toBe('')
  // A budget miss, not a crash or a timeout of the harness.
  expect(message).toMatch(/toBeLessThan/)
  return message
}

const ready = async (page: Page) => expect(page.getByTestId('canvas')).toBeVisible()

test('probe: a 40 ms off-CPU stall on every 4th key fails the budget (wall-clock tail)', async ({ app, page }) => {
  await ready(page)
  await stallEveryFourthKey(app, page, scaled(40))
  await failsBudget(page)
})

test('probe: a 20 ms busy-wait on every key fails the budget (CPU per key)', async ({ page }) => {
  await ready(page)
  await page.evaluate((ms) =>
    window.addEventListener('keydown', () => {
      const t = performance.now()
      while (performance.now() - t < ms) {
        // Busy: the key's handler costs 20 ms (scaled) of main-thread CPU.
      }
    }, { capture: true }),
  scaled(20))
  await failsBudget(page)
})

test('probe: 20 ms of work in the frame after each input fails the budget (slow render)', async ({ page }) => {
  await ready(page)
  await page.evaluate((ms) =>
    window.addEventListener('beforeinput', () =>
      requestAnimationFrame(() => {
        const t = performance.now()
        while (performance.now() - t < ms) {
          // Busy in the frame that renders the key.
        }
      }),
    ),
  scaled(20))
  await failsBudget(page)
})

test('probe: a page open 150 ms slower fails the budget', async ({ page }) => {
  await ready(page)
  // 150 ms of work after the page's click handler has started the open (React handles the click at its root, so a
  // window listener in the bubble phase runs after it), on every open.
  await page.evaluate((ms) =>
    window.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-testid="page-item"]')) return
      const t = performance.now()
      while (performance.now() - t < ms) {
        // Busy while the page opens.
      }
    }),
  scaled(150))
  const message = await failsBudget(page)
  // The page-open check is the one that missed: its scaled budget is the expected value.
  expect(stripVTControlCharacters(message)).toContain(`Expected: < ${BUDGET.pageOpen}\n`)
})

/** A synchronous request on every 4th key, held 40 ms in main: the renderer thread waits with no CPU used. */
async function stallEveryFourthKey(app: ElectronApplication, page: Page, ms: number): Promise<void> {
  // The app's own scheme, which the CSP allows to connect; every other request passes untouched.
  await app.evaluate(({ session }, hold) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, done) => {
      if (d.url.startsWith('app://slate/__perf-stall')) setTimeout(() => done({ cancel: true }), hold)
      else done({})
    })
  }, ms)
  await page.evaluate(() => {
    let n = 0
    window.addEventListener('beforeinput', () => {
      if (++n % 4 !== 0) return
      const xhr = new XMLHttpRequest()
      try {
        xhr.open('GET', 'app://slate/__perf-stall', false)
        xhr.send()
      } catch {
        // Cancelled after the hold: the wait is what this probe is for.
      }
    })
  })
}
