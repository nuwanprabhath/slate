import type { Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

/** Phase 15 WP-C2 in the real window: Tab indent, moving blocks, the format painter and folded headings. */
const focusedEditor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')

async function newBox(page: Page, lines: string[]) {
  await createBoxAt(page, 160, 160)
  await expect(focusedEditor(page)).toHaveText('')
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    await page.keyboard.type(line)
  }
}

/** Selects `text` in the box with the mouse, as a person does before the painter paints it. */
async function dragSelect(page: Page, text: string) {
  const r = await page.evaluate((t) => {
    const walker = document.createTreeWalker(document.querySelector('[data-testid="box-editor"]')!, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent!.indexOf(t)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(n, at)
      range.setEnd(n, at + t.length)
      const b = range.getBoundingClientRect()
      return { x: b.left, y: b.top + b.height / 2, right: b.right }
    }
    throw new Error(`no text ${t}`)
  }, text)
  await page.mouse.move(r.x + 1, r.y)
  await page.mouse.down()
  await page.mouse.move(r.right - 1, r.y, { steps: 4 })
  await page.mouse.up()
}

test('Tab indents a paragraph in 24px steps and keeps focus; Shift+Tab outdents', async ({ page }) => {
  await newBox(page, ['first', 'second'])
  const second = page.getByTestId('box-editor').locator('p').nth(1)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(second).toHaveCSS('margin-left', '48px')
  await expect(focusedEditor(page)).toHaveCount(1)
  await page.keyboard.type('!')
  await expect(second).toHaveText('second!')
  await page.keyboard.press('Shift+Tab')
  await expect(second).toHaveCSS('margin-left', '24px')
})

test('Alt+Shift+Up/Down moves the current line, and one undo puts it back', async ({ page }) => {
  await newBox(page, ['a', 'b', 'c'])
  const lines = page.getByTestId('box-editor').locator('p')
  // Edits closer together than PageSession's undo merge interval (500 ms) are one undo step.
  await page.waitForTimeout(700)
  await page.keyboard.press('Alt+Shift+ArrowUp')
  await expect(lines).toHaveText(['a', 'c', 'b'])
  await page.waitForTimeout(700)
  await page.keyboard.press('Alt+Shift+ArrowUp')
  await expect(lines).toHaveText(['c', 'a', 'b'])
  await page.keyboard.press(`${MOD}+z`)
  await expect(lines).toHaveText(['a', 'c', 'b'])
})

test('format painter: a click paints one selection, a double-click stays on until Escape', async ({ page }) => {
  await newBox(page, ['bold source', 'plain target', 'more text'])
  const editor = page.getByTestId('box-editor')
  await dragSelect(page, 'bold source')
  await page.keyboard.press(`${MOD}+b`)
  await expect(editor.locator('p').first().locator('strong')).toHaveText('bold source')
  const brush = page.getByTestId('tb-format-painter')
  await brush.click()
  await expect(brush).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-format-painter', 'on')
  await dragSelect(page, 'plain target')
  await expect(editor.locator('p').nth(1).locator('strong')).toHaveCount(1)
  await expect(brush).toHaveAttribute('aria-pressed', 'false')

  await editor.locator('p').first().click()
  await brush.dblclick()
  await expect(brush).toHaveAttribute('aria-pressed', 'true')
  await dragSelect(page, 'more text')
  await expect(editor.locator('p').nth(2).locator('strong')).toHaveCount(1)
  await expect(brush).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(brush).toHaveAttribute('aria-pressed', 'false')
})

test('folding a heading hides its section until the next heading and shows "…"', async ({ page }) => {
  await newBox(page, ['Groceries', 'milk', 'Chores', 'dishes'])
  const editor = page.getByTestId('box-editor')
  for (const text of ['Groceries', 'Chores']) {
    await editor.getByText(text).click()
    await page.getByTestId('tb-h2').click()
  }
  const groceries = editor.locator('h2').first()
  await groceries.hover()
  const toggle = groceries.locator('.slate-fold-toggle')
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(editor.getByText('milk')).toBeHidden()
  await expect(editor.getByText('dishes')).toBeVisible()
  await expect(groceries).toHaveClass(/slate-folded/)
  await groceries.locator('.slate-fold-toggle').click()
  await expect(editor.getByText('milk')).toBeVisible()
})

test('find opens a fold hiding the match it moves to, from the find bar and from Find in Notes', async ({ page }) => {
  await newBox(page, ['Groceries', 'milk', 'Chores', 'dishes'])
  const editor = page.getByTestId('box-editor')
  for (const text of ['Groceries', 'Chores']) {
    await editor.getByText(text).click()
    await page.getByTestId('tb-h2').click()
  }
  const fold = async (heading: string) => {
    const h = editor.locator('h2', { hasText: heading })
    await h.hover()
    await h.locator('.slate-fold-toggle').click()
    await expect(h).toHaveClass(/slate-folded/)
  }
  await fold('Groceries')
  await expect(editor.getByText('milk')).toBeHidden()

  await page.keyboard.press(`${MOD}+f`)
  await page.getByTestId('find-input').fill('milk')
  await expect(page.getByTestId('find-count')).toHaveText('1 of 1')
  await expect(page.locator('.slate-find-current')).toBeVisible()
  await expect(editor.locator('h2', { hasText: 'Groceries' })).not.toHaveClass(/slate-folded/)
  await page.keyboard.press('Escape')

  await fold('Chores')
  await expect(editor.getByText('dishes')).toBeHidden()
  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.getByTestId('search-input').fill('dishes')
  await page.getByTestId('search-match').click()
  await expect(page.locator('.slate-find-current')).toBeVisible()
  await expect(editor.getByText('dishes')).toBeVisible()
  await expect(editor.locator('h2', { hasText: 'Chores' })).not.toHaveClass(/slate-folded/)
})
