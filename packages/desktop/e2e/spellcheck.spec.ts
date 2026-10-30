import type { ElectronApplication } from '@playwright/test'
import { boxWithText } from './canvasHelpers'
import { expect, test } from './fixtures'

const checkerOn = (app: ElectronApplication) => app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())

test('"Underline misspelled words" starts off, and turns on the checker and the editors\' spellcheck', async ({ app, page }) => {
  const box = await boxWithText(page, 60, 60, 'Teh qiuck fox')
  const editor = box.getByTestId('box-editor')
  await expect(editor).toHaveAttribute('spellcheck', 'false')
  expect(await checkerOn(app)).toBe(false)

  await page.getByTestId('activity-settings').click()
  const setting = page.getByTestId('setting-spellcheck-underline')
  await expect(setting).not.toBeChecked()
  await setting.check()
  await expect.poll(() => checkerOn(app)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="box-editor"]').first()).toHaveAttribute('spellcheck', 'true')
  // Underlining never corrects: the text is as typed.
  await expect(page.locator('[data-testid="box-editor"]').first()).toHaveText('Teh qiuck fox')
  await expect(page.locator('[data-testid="box-editor"]').first()).toHaveAttribute('autocorrect', 'off')

  await page.getByTestId('activity-settings').click()
  await page.getByTestId('setting-spellcheck-underline').uncheck()
  await expect.poll(() => checkerOn(app)).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="box-editor"]').first()).toHaveAttribute('spellcheck', 'false')
})
