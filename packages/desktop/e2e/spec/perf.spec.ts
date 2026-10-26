// @product-rule performance-budget (CLAUDE.md, Product rules). A guarded spec: its expectations only grow, and only the maintainer changes the rule.
import { expect, test } from '../fixtures'
import { measure } from './perfMeasure'

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
