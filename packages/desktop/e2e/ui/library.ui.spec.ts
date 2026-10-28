import { expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'

const LONG = 'Quarterly planning notes for the infrastructure migration and the platform team'

/** The library with long names, the toolbar, the find bar and the context menus. */
test('UI: library, toolbar, find bar and context menus', async ({ app, page }) => {
  test.setTimeout(240_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.getByTestId('add-section').click()
  await page.getByTestId('inline-rename').fill(LONG)
  await page.keyboard.press('Enter')
  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill(LONG)
  await page.keyboard.press('Enter')
  await reviewUi(app, page, 'library long names')
  await reviewUi(app, page, 'page context menu', {
    open: (p) => p.getByTestId('page-item').first().click({ button: 'right' }),
    close: (p) => p.keyboard.press('Escape'),
  })
  await reviewUi(app, page, 'section context menu', {
    open: (p) => p.getByTestId('section-item').first().click({ button: 'right' }),
    close: (p) => p.keyboard.press('Escape'),
  })
  await reviewUi(app, page, 'find bar', {
    open: async (p) => {
      if (!(await p.getByTestId('find-bar').isVisible())) {
        await p.getByTestId('canvas').click({ position: { x: 300, y: 300 } })
        await p.keyboard.press(`${MOD}+f`)
      }
      await p.getByTestId('find-input').fill('deploy')
    },
  })
})
