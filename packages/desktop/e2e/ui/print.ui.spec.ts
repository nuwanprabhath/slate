import { boxWithText } from '../canvasHelpers'
import { clickMenu, expect, test } from '../fixtures'
import { holdSaveDialog } from '../printHelpers'
import { reviewUi } from './review'

/**
 * What File → Print and Export Page as PDF put on paper, shown in the window: the print stylesheet
 * applied (print media, html.print-page) while the save dialog is held open. In every theme the
 * page must come out dark on white, with no app chrome and no box handles or selection rings.
 */
test('UI: page laid out for print', async ({ app, page }) => {
  await page.getByTestId('page-title').fill('Trip planning — a long page title that wraps on paper rather than being cut off at the edge')
  await page.getByTestId('page-title').press('Enter')
  await boxWithText(page, 40, 40, 'Packing list\nPassport, charger, a jumper for the plane.')
  await boxWithText(page, 520, 120, 'A box far to the right, so the page is scaled down to fit the paper width.')
  const selected = await boxWithText(page, 80, 300, 'This box was selected when printing started: its ring and handle must not print.')
  await selected.getByTestId('box-handle').click()
  const dialog = await holdSaveDialog(app, null)
  await clickMenu(app, 'export-pdf')
  await expect(page.locator('html.print-page')).toHaveCount(1)
  try {
    await reviewUi(app, page, 'page laid out for print', {
      open: async (p) => {
        await p.emulateMedia({ media: 'print' })
        await expect(p.locator('.page-print-title')).toBeVisible()
      },
      close: (p) => p.emulateMedia({ media: null }),
    })
  } finally {
    await page.emulateMedia({ media: null })
    await dialog.release()
  }
})
