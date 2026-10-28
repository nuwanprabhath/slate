import { expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'

/** Every Settings section, as the registry lists them (the nav is the registry rendered), scrolled through. */
test('UI: every Settings section', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.keyboard.press(`${MOD}+,`)
  const ids = await page.locator('.settings-nav-item').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').replace('settings-nav-', '')))
  expect(ids.length).toBeGreaterThan(5)
  await page.keyboard.press('Escape')
  for (const id of ids) {
    await reviewUi(app, page, `settings ${id}`, {
      scroll: '[data-testid="settings-pane"]',
      open: async (p) => {
        if (!(await p.getByTestId('settings-dialog').isVisible())) await p.keyboard.press(`${MOD}+,`)
        await p.getByTestId(`settings-nav-${id}`).click()
        await expect(p.getByTestId('settings-heading')).toBeVisible()
      },
    })
  }
})
