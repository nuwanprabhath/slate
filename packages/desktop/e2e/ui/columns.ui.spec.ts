import { expect, test } from '../fixtures'
import { reviewUi } from './review'
import { unlockedApp } from './states'

/** The toolbar's lock button (an encrypted vault), at both widths. */
test('UI: toolbar with the lock button', async () => {
  const { app, page } = await unlockedApp()
  try {
    await expect(page.getByTestId('toolbar-lock')).toBeVisible()
    await reviewUi(app, page, 'toolbar lock')
  } finally {
    await app.close()
  }
})

/** The library's collapsible columns: the hover chevron, each column collapsed, and both. */
test('UI: collapsing the library columns', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await reviewUi(app, page, 'splitter hover', {
    open: async (p) => {
      await p.getByTestId('splitter-sections').hover()
      await expect(p.getByTestId('collapse-sections')).toBeVisible()
    },
  })
  await page.getByTestId('splitter-sections').hover()
  await page.getByTestId('collapse-sections').click()
  await expect(page.getByTestId('expand-sections')).toBeVisible()
  await reviewUi(app, page, 'sections collapsed')
  await page.getByTestId('splitter-pages').hover()
  await page.getByTestId('collapse-pages').click()
  await expect(page.getByTestId('expand-pages')).toBeVisible()
  await reviewUi(app, page, 'both collapsed')
  await page.getByTestId('expand-sections').click()
  await expect(page.getByTestId('sections-column')).toBeVisible()
  await reviewUi(app, page, 'pages collapsed')
})
