import type { Locator, Page } from '@playwright/test'
import { expect, MOD, test } from './fixtures'
import { boxWithText, rect } from './canvasHelpers'

/** A plain click on a box's title bar, as the maintainer does it: it selects that box. */
async function clickTitleBar(b: Locator): Promise<void> {
  await b.hover()
  await b.getByTestId('box-handle').click()
  await expect(b).toHaveAttribute('aria-selected', 'true')
}

/** A click on empty canvas at (x, y), canvas coordinates: the paste point. */
async function clickCanvas(page: Page, x: number, y: number): Promise<void> {
  await page.getByTestId('canvas').click({ position: { x, y } })
  await expect(page.getByTestId('pending-caret')).toBeVisible()
}

async function boxOffset(page: Page, b: Locator): Promise<{ x: number; y: number }> {
  const c = await rect(page.getByTestId('canvas'))
  const r = await rect(b)
  return { x: Math.round(r.x - c.x), y: Math.round(r.y - c.y) }
}

test('Mod+X on a clicked title bar marks the box cut; a click elsewhere and Mod+V moves it there', async ({ page }) => {
  const a = await boxWithText(page, 60, 60, 'move me')
  const other = await boxWithText(page, 600, 60, 'stays')
  await clickTitleBar(a)
  await page.keyboard.press(`${MOD}+x`)
  await expect(a).toHaveClass(/is-cut/)
  await expect(a.locator('.slate-box-body')).toHaveCSS('opacity', '0.5')
  await expect(a).toHaveCSS('outline-style', 'dashed')
  await expect(other).not.toHaveClass(/is-cut/)
  await expect(page.getByTestId('box')).toHaveCount(2)

  await clickCanvas(page, 200, 400)
  await page.keyboard.press(`${MOD}+v`)
  await expect.poll(() => boxOffset(page, a)).toEqual({ x: 200, y: 400 })
  await expect(page.getByTestId('box')).toHaveCount(2)
  await expect(a).toContainText('move me')
  await expect(a).not.toHaveClass(/is-cut/)

  // One undo puts it back.
  await page.getByTestId('canvas').focus()
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => boxOffset(page, a)).toEqual({ x: 60, y: 60 })
})

test('cut on page 1 and paste on page 2 moves the box off page 1', async ({ page }) => {
  const a = await boxWithText(page, 60, 60, 'travelling box')
  await boxWithText(page, 60, 300, 'stays on page one')
  await clickTitleBar(a)
  await page.keyboard.press(`${MOD}+x`)
  await expect(a).toHaveClass(/is-cut/)

  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('Second')
  await expect(page.getByTestId('box')).toHaveCount(0)
  await clickCanvas(page, 120, 140)
  await page.keyboard.press(`${MOD}+v`)
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box')).toContainText('travelling box')
  expect(await boxOffset(page, page.getByTestId('box'))).toEqual({ x: 120, y: 140 })

  await page.getByTestId('page-item').filter({ hasText: 'Untitled page' }).click()
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box')).toContainText('stays on page one')

  await page.getByTestId('page-item').filter({ hasText: 'Second' }).click()
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box')).toContainText('travelling box')
})

test('undo of a cross-page paste restores the source page', async ({ page }) => {
  const a = await boxWithText(page, 60, 60, 'comes back')
  await clickTitleBar(a)
  await page.keyboard.press(`${MOD}+x`)
  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('Second')
  await clickCanvas(page, 100, 100)
  await page.keyboard.press(`${MOD}+v`)
  await expect(page.getByTestId('box')).toContainText('comes back')
  await page.getByTestId('canvas').focus()
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.getByTestId('page-item').filter({ hasText: 'Untitled page' }).click()
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box')).toContainText('comes back')
  expect(await boxOffset(page, page.getByTestId('box'))).toEqual({ x: 60, y: 60 })
})

test('Mod+C copies: pasting twice makes two copies, and the system clipboard has the text', async ({ app, page }) => {
  const a = await boxWithText(page, 60, 60, 'copied twice')
  await clickTitleBar(a)
  await page.keyboard.press(`${MOD}+c`)
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('copied twice')
  await clickCanvas(page, 100, 300)
  await page.keyboard.press(`${MOD}+v`)
  await expect(page.getByTestId('box')).toHaveCount(2)
  await clickCanvas(page, 600, 300)
  await page.keyboard.press(`${MOD}+v`)
  await expect(page.getByTestId('box')).toHaveCount(3)
  await expect(page.getByTestId('box').filter({ hasText: 'copied twice' })).toHaveCount(3)
  // Undo of a paste is one step.
  await page.getByTestId('canvas').focus()
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('box')).toHaveCount(2)
})

test('Mod+V pastes the system clipboard as text once it no longer holds the copied boxes', async ({ app, page }) => {
  const a = await boxWithText(page, 60, 60, 'box text')
  await clickTitleBar(a)
  await page.keyboard.press(`${MOD}+c`)
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('box text')
  await app.evaluate(({ clipboard }) => clipboard.writeText('from another app'))
  await clickCanvas(page, 100, 300)
  await page.keyboard.press(`${MOD}+v`)
  await expect(page.getByTestId('box')).toHaveCount(2)
  await expect(page.getByTestId('box').filter({ hasText: 'from another app' })).toHaveCount(1)
})

test('Mod+D duplicates the selected boxes 24px right and down and selects the copies', async ({ page }) => {
  const a = await boxWithText(page, 60, 60, 'twin')
  await clickTitleBar(a)
  await page.keyboard.press(`${MOD}+d`)
  await expect(page.getByTestId('box')).toHaveCount(2)
  const copy = page.getByTestId('box').and(page.locator('[aria-selected="true"]'))
  await expect(copy).toHaveCount(1)
  await expect(copy).toContainText('twin')
  expect(await boxOffset(page, copy)).toEqual({ x: 84, y: 84 })
  await expect(a).toHaveAttribute('aria-selected', 'false')
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('box')).toHaveCount(1)
})

test('Esc cancels the cut mark, and so does editing the box', async ({ page }) => {
  const a = await boxWithText(page, 60, 60, 'not cut')
  await clickTitleBar(a)
  await page.keyboard.press(`${MOD}+x`)
  await expect(a).toHaveClass(/is-cut/)
  await page.keyboard.press('Escape')
  await expect(a).not.toHaveClass(/is-cut/)

  await clickTitleBar(a)
  await page.keyboard.press(`${MOD}+x`)
  await expect(a).toHaveClass(/is-cut/)
  await a.locator('.slate-box-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await expect(a).not.toHaveClass(/is-cut/)
  await expect(page.getByTestId('box')).toHaveCount(1)
})
