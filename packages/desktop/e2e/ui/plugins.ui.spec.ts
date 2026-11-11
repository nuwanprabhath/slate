import { expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'
import { stubInvoke } from './states'

/**
 * A plugin panel whose render throws. Main answers `search:query` with a malformed result, which
 * the Search panel's render cannot walk, so the plugin error boundary (plugins/boundary.tsx)
 * replaces that panel with its fallback. The rest of the app, and the other tools, keep working.
 */
test('UI: a plugin panel that fails to render', async ({ app, page }) => {
  test.setTimeout(240_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await stubInvoke(app, 'search:query', { pages: 7, total: 1, truncated: false })
  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.getByTestId('search-input').fill('cat')
  await expect(page.getByTestId('plugin-error')).toBeVisible()
  await expect(page.getByTestId('plugin-error-retry')).toBeVisible()

  await reviewUi(app, page, 'plugin panel error fallback', {
    open: async (p) => void (await expect(p.getByTestId('plugin-error')).toBeVisible()),
  })

  // The failure is this plugin's alone: the other tool still opens, and the page is still editable.
  await page.getByTestId('activity-library.notebooks').click()
  await expect(page.getByTestId('library-panel')).toBeVisible()
  await expect(page.getByTestId('plugin-error')).toBeHidden()
  await page.getByTestId('page-title').fill('Still working')
  await expect(page.getByTestId('page-title')).toHaveValue('Still working')

  // Coming back rebuilds the panel, and it fails the same way rather than taking the app down.
  await page.getByTestId('activity-search.panel').click()
  await expect(page.getByTestId('plugin-error')).toBeVisible()
})
