import type { Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'

/** Phase 15 WP-C2: indented paragraphs, the format painter on, a folded heading; every theme at 800 and 1280 px. */
const focusedEditor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')

/** Types lines; each indent step is relative to the line before, since Enter keeps the indent. */
async function newBox(page: Page, lines: Array<[text: string, step: number]>) {
  await createBoxAt(page, 80, 80)
  await expect(focusedEditor(page)).toHaveText('')
  for (const [i, [text, step]] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    for (let t = 0; t < Math.abs(step); t++) await page.keyboard.press(step > 0 ? 'Tab' : 'Shift+Tab')
    await page.keyboard.type(text)
  }
}

test('UI: indented paragraphs', async ({ app, page }) => {
  await newBox(page, [
    ['Plan for the week', 0],
    ['Monday: write the release notes', 1],
    ['Check the changelog against the merged branches', 1],
    ['Tuesday: review', -1],
    ['Back at the left edge', -1],
  ])
  await expect(page.getByTestId('box-editor').locator('p').nth(2)).toHaveCSS('margin-left', '48px')
  await reviewUi(app, page, 'indented paragraphs')
})

test('UI: format painter on', async ({ app, page }) => {
  await newBox(page, [['', 0]])
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.type('Painted from here')
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.type(' to there')
  for (let i = 0; i < ' to there'.length + 3; i++) await page.keyboard.press('ArrowLeft')
  const editor = page.getByTestId('box-editor')
  await expect(editor.locator('strong')).toHaveText('Painted from here')
  await page.getByTestId('tb-format-painter').dblclick()
  await expect(page.getByTestId('tb-format-painter')).toHaveAttribute('aria-pressed', 'true')
  await reviewUi(app, page, 'format painter on')
})

test('UI: folded heading', async ({ app, page }) => {
  await newBox(page, [
    ['Groceries', 0],
    ['milk, eggs, bread', 0],
    ['Chores', 0],
    ['dishes', 0],
  ])
  const editor = page.getByTestId('box-editor')
  for (const text of ['Groceries', 'Chores']) {
    await editor.getByText(text).click()
    await page.getByTestId('tb-h2').click()
  }
  const groceries = editor.locator('h2').first()
  await groceries.hover()
  await groceries.locator('.slate-fold-toggle').click()
  await expect(editor.getByText('milk, eggs, bread')).toBeHidden()
  await reviewUi(app, page, 'folded heading', {
    // The second heading's toggle shows on hover, beside the first one's folded ▸.
    open: (p) => p.getByTestId('box-editor').locator('h2').nth(1).hover(),
  })
})
