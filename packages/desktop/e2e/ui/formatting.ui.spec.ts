import type { Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'

/** Phase 15 WP-C1: the to-do list, the alignment menu and sub/superscript, with the toolbar at 800 and 1280 px in every theme. */
const focusedEditor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')

async function newBox(page: Page, text: string) {
  await createBoxAt(page, 80, 80)
  await expect(focusedEditor(page)).toHaveText('')
  await page.keyboard.type(text)
}

test('UI: to-do list, ticked and unticked, nested', async ({ app, page }) => {
  await newBox(page, 'Buy milk')
  await page.getByTestId('tb-todo').click()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Pick up the parcel from the post office')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Brown eggs')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Free range')
  const editor = page.getByTestId('box-editor')
  const first = editor.locator('li').first()
  const text = (await first.locator('> p').boundingBox())!
  await page.mouse.click(text.x - 12, text.y + text.height / 2)
  await expect(first).toHaveAttribute('data-checked', 'true')
  const nested = editor.locator('li li').first()
  const nestedText = (await nested.locator('> p').boundingBox())!
  await page.mouse.click(nestedText.x - 12, nestedText.y + nestedText.height / 2)
  await expect(nested).toHaveAttribute('data-checked', 'true')
  await editor.locator('li li').last().locator('> p').click()
  await expect(page.getByTestId('tb-todo')).toHaveAttribute('aria-pressed', 'true')
  await reviewUi(app, page, 'to-do list')
})

test('UI: alignment menu open', async ({ app, page }) => {
  await newBox(page, 'A centred line')
  await page.keyboard.press(`${MOD}+Shift+e`)
  await reviewUi(app, page, 'alignment menu open', {
    open: async (p) => {
      await p.getByTestId('tb-align').click()
      await expect(p.getByTestId('align-center')).toHaveAttribute('aria-checked', 'true')
    },
    close: async (p) => {
      await p.keyboard.press('Escape')
      await expect(p.getByTestId('align-center')).toHaveCount(0)
    },
  })
})

test('UI: sub and superscript', async ({ app, page }) => {
  await newBox(page, 'Water is H2O and e = mc2')
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.getByTestId('tb-superscript').click()
  for (let i = 0; i < 'O and e = mc2'.length; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.getByTestId('tb-subscript').click()
  const editor = page.getByTestId('box-editor')
  await expect(editor.locator('sub')).toHaveText('2')
  await expect(editor.locator('sup')).toHaveText('2')
  await expect(page.getByTestId('tb-subscript')).toHaveAttribute('aria-pressed', 'true')
  await reviewUi(app, page, 'sub and superscript')
})
