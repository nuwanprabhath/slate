// @product-rule no-auto-formatting (CLAUDE.md, Product rules). A guarded spec: its expectations only grow, and only the maintainer changes the rule.
import type { Page } from '@playwright/test'
import { createBoxAt,expect, MOD, test, clickMenu } from '../fixtures'

const focusedEditor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')

async function newLineAfterHeading(page: Page) {
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveCount(1)
  await page.keyboard.press('End')
  // The native End key changes only the DOM selection; ProseMirror adopts it on the next
  // selectionchange event. Synthetic keys arrive faster than a person types, so let a frame pass.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="box-editor"] h1 + p')).toHaveCount(1)
}

async function typeInNewBox(page: Page, text: string, x = 120, y = 120) {
  await createBoxAt(page, x, y)
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

test('headings, quotes, lists, code fences and smart quotes are not made from typing (red team final F-2)', async ({ page }) => {
  const lines = ['# heading', '## heading', '> quote', '- dash', '+ plus', '1. one', '1) one', '[ ] task', '```js', '---', '"quoted" it\'s -- wait...']
  await createBoxAt(page, 120, 120)
  await expect(focusedEditor(page)).toHaveText('')
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    await page.keyboard.type(`${line} `)
  }
  const editor = page.getByTestId('box-editor')
  await expect(editor.locator('h1, h2, h3, blockquote, ul, ol, pre, code, hr, strong, em, s')).toHaveCount(0)
  await expect(editor.locator('p')).toHaveCount(lines.length)
  for (const [i, line] of lines.entries()) await expect(editor.locator('p').nth(i)).toHaveText(`${line} `)
})

test('`* ` is the one exception: it starts a bullet list (autoBullets), and nothing else does', async ({ page }) => {
  await typeInNewBox(page, '* item')
  const editor = page.getByTestId('box-editor')
  await expect(editor.locator('ul > li')).toHaveText('item')
  await expect(editor.locator('h1, h2, h3, blockquote, ol, pre')).toHaveCount(0)
})

test('Markdown Shortcuts setting turns on input rules', async ({ app, page }) => {
  await clickMenu(app, 'markdown-shortcuts')
  await expect.poll(() => page.evaluate(() => window.slate.settings.get().then((s) => s.markdownShortcuts))).toBe(true)
  // Main has it first; the renderer a moment later. A box made before that has no input rules.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { slateTest: { editorSettings: () => { markdownShortcuts: boolean } | null } }).slateTest.editorSettings()?.markdownShortcuts))
    .toBe(true)
  await typeInNewBox(page, '1. now a list', 120, 300)
  await expect(focusedEditor(page).locator('ol > li')).toHaveText('now a list')
})
