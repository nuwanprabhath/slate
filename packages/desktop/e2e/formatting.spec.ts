import type { Page } from '@playwright/test'
import { expect, MOD, test } from './fixtures'

const focusedEditor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')

// A toolbar control hands focus back to the editor asynchronously, and ProseMirror learns of a
// moved selection a tick after the key. Until both have happened End/Enter is a no-op (the
// selection is still "all"), so repeat the pair until a paragraph follows the heading.
const newLineAfterHeading = (page: Page) =>
  expect
    .poll(async () => {
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      return page.locator('[data-testid="box-editor"] h1 + p').count()
    })
    .toBe(1)

async function typeInNewBox(page: Page, text: string, x = 120, y = 120) {
  await page.getByTestId('canvas').click({ position: { x, y } })
  await expect(focusedEditor(page)).toHaveText('')
  await page.keyboard.type(text)
}

test('toolbar applies marks, headings, lists, tables and fonts', async ({ page }) => {
  await typeInNewBox(page, 'format me')
  const editor = page.getByTestId('box-editor')
  await page.keyboard.press(`${MOD}+a`)
  await page.getByTestId('tb-bold').click()
  await expect(editor.locator('strong')).toHaveText('format me')
  await page.getByTestId('tb-font').selectOption('monospace')
  await expect(editor.locator('span[style*="font-family"]')).toHaveCount(1)
  await page.getByTestId('tb-h1').click()
  await expect(editor.locator('h1')).toHaveText('format me')
  await newLineAfterHeading(page)
  await page.getByTestId('tb-ordered').click()
  await page.keyboard.type('item')
  await expect(editor.locator('ol > li')).toHaveText('item')
  await page.getByTestId('tb-table').click()
  await expect(editor.locator('table td')).toHaveCount(9)
})

test('typing markdown-like text does not auto-format by default', async ({ page }) => {
  await typeInNewBox(page, '1. not a list')
  const editor = page.getByTestId('box-editor')
  await expect(editor.locator('ol')).toHaveCount(0)
  await expect(editor).toHaveText('1. not a list')
})

test('Markdown Shortcuts setting turns on input rules', async ({ app, page }) => {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('markdown-shortcuts')!.click())
  await typeInNewBox(page, '1. now a list', 120, 300)
  await expect(focusedEditor(page).locator('ol > li')).toHaveText('now a list')
})
