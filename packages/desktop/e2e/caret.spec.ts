import type { Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

const frame = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))))

const measure = (page: Page) =>
  page.evaluate(() => {
    const r = window.getSelection()!.getRangeAt(0)
    const rects = r.getClientRects()
    const node = r.startContainer.nodeType === 3 ? r.startContainer.parentElement! : (r.startContainer as HTMLElement)
    const range = rects.length ? rects[0]! : (node.closest('p') ?? node).getBoundingClientRect()
    const el = document.querySelector('[data-testid="slate-caret"]') as HTMLElement | null
    const caret = el?.getBoundingClientRect()
    const editor = document.querySelector('[data-testid="box-editor"]')!
    return {
      range: { left: range.left, top: range.top, bottom: range.bottom, height: range.height },
      caret: caret && { left: caret.left, bottom: caret.bottom, height: caret.height },
      visible: !!el && getComputedStyle(el).display !== 'none',
      caretColor: getComputedStyle(editor).caretColor,
    }
  })

test.beforeEach(async ({ page }) => {
  await page.evaluate(() =>
    window.slate.settings.set({ themeId: 'builtin:paper', fontOverrides: { 'builtin:paper': { note: 'System UI', ui: 'System UI' } } }),
  )
  await createBoxAt(page, 120, 120)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type('is not busy.')
  await frame(page)
})

test('a drawn caret covers the whole line box and hides the native caret', async ({ page }) => {
  const m = await measure(page)
  expect(m.visible).toBe(true)
  expect(m.caret!.height).toBeGreaterThanOrEqual(m.range.height - 0.01)
  expect(m.caret!.bottom).toBeGreaterThanOrEqual(m.range.bottom - 0.5)
  expect(Math.abs(m.caret!.left - m.range.left)).toBeLessThanOrEqual(1)
  expect(m.caretColor).toBe('rgba(0, 0, 0, 0)')
})

test('arrow keys move the caret', async ({ page }) => {
  const before = (await measure(page)).caret!.left
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await frame(page)
  const m = await measure(page)
  expect(m.caret!.left).toBeLessThan(before - 2)
  expect(Math.abs(m.caret!.left - m.range.left)).toBeLessThanOrEqual(1)
})

test('a selection or blur hides the caret and restores the native one', async ({ page }) => {
  await page.keyboard.press('Shift+ArrowLeft')
  await frame(page)
  let m = await measure(page)
  expect(m.visible).toBe(false)
  expect(m.caretColor).not.toBe('rgba(0, 0, 0, 0)')
  await page.keyboard.press('ArrowRight')
  await frame(page)
  expect((await measure(page)).visible).toBe(true)
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  await frame(page)
  m = await measure(page)
  expect(m.visible).toBe(false)
  expect(m.caretColor).not.toBe('rgba(0, 0, 0, 0)')
})

test('the caret follows a larger size and another font', async ({ page }) => {
  await page.keyboard.press(`${MOD}+a`)
  await page.getByTestId('tb-size').selectOption('32px')
  await page.getByTestId('tb-font').selectOption('monospace')
  await page.locator('[data-testid="box-editor"]').focus()
  await page.keyboard.press('End')
  await frame(page)
  const m = await measure(page)
  expect(m.visible).toBe(true)
  expect(m.caret!.height).toBeGreaterThanOrEqual(32 * 0.95)
  expect(m.caret!.bottom).toBeGreaterThanOrEqual(m.range.bottom - 0.5)
  expect(Math.abs(m.caret!.left - m.range.left)).toBeLessThanOrEqual(1)
})
