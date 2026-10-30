import { expect, MOD, test } from '../fixtures'
import { boxWithText } from '../canvasHelpers'
import { reviewUi } from './review'

test('UI: find bar with replace', async ({ app, page }) => {
  await boxWithText(page, 60, 60, 'The cat sat on the mat. Another cat, and a Cat.')
  await boxWithText(page, 60, 220, 'A second box with one more cat.')
  await page.keyboard.press(`${MOD}+f`)
  await page.getByTestId('find-input').fill('cat')
  await page.getByTestId('find-replace-toggle').click()
  await page.getByTestId('replace-input').fill('dog')
  await page.getByTestId('replace-preserveCase').click()
  await expect(page.getByTestId('find-count')).toHaveText('1 of 4')
  await reviewUi(app, page, 'find bar with replace')
})

test('UI: find in notes replace preview', async ({ app, page }) => {
  await page.getByTestId('page-title').fill('Shopping list for the long weekend away')
  await boxWithText(page, 60, 60, 'Buy food for the cat, and a new bed for the cat before Friday.')
  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('Vet')
  await boxWithText(page, 60, 60, 'Cat vaccinations are due in March.')
  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.getByTestId('search-input').fill('cat')
  await expect(page.getByTestId('search-summary')).toHaveText('3 results in 2 pages')
  await page.getByTestId('search-replace-toggle').click()
  await page.getByTestId('search-replace-input').fill('dog')
  await page.getByTestId('search-replace-preserveCase').click()
  await page.getByTestId('search-replace-all').click()
  await page.getByTestId('search-match').nth(1).getByRole('checkbox').uncheck()
  await expect(page.getByTestId('search-replace-confirm')).toHaveText('Replace 2 in 2 pages')
  await reviewUi(app, page, 'find in notes replace preview')
})

test('UI: find in notes replace, notes changed since the search', async ({ app, page }) => {
  await boxWithText(page, 60, 60, 'keep cat, change cat')
  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.getByTestId('search-input').fill('cat')
  await page.getByTestId('search-replace-toggle').click()
  await page.getByTestId('search-replace-input').fill('dog')
  await page.getByTestId('search-replace-all').click()
  await page.getByTestId('box').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
  await page.keyboard.type('cat ')
  await page.getByTestId('search-replace-confirm').click()
  await expect(page.getByTestId('search-notice')).toBeVisible()
  await reviewUi(app, page, 'find in notes replace notice')
})
