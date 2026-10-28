import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, MOD, test } from './fixtures'
import { boxWithText, drag, moveBoxTo, overlap, rect } from './canvasHelpers'

test('the handle of a box under another box can still be grabbed', async ({ page }) => {
  const a = await boxWithText(page, 100, 100, 'upper box with some text in it\nsecond line\nthird line')
  const b = await boxWithText(page, 100, 400, 'lower box')
  // B's handle (18px above its top) lands inside A's body.
  await moveBoxTo(page, b, a, 40, 40)
  const ar = await rect(a)
  // A to the front: B's body is now under A's.
  await a.locator('.slate-box-content').click({ position: { x: 5, y: 5 } })
  const handle = await rect(b.getByTestId('box-handle'))
  expect(overlap(handle, ar)).toBe(true)
  const before = await rect(b)
  await drag(page, { x: handle.x + 30, y: handle.y + 9 }, { x: handle.x + 30 + 300, y: handle.y + 9 + 200 })
  await expect.poll(async () => Math.round((await rect(b)).x - before.x)).toBe(300)
  expect(Math.round((await rect(a)).x)).toBe(Math.round(ar.x))
})

test('overlapping boxes do not show through each other', async ({ page }) => {
  const a = await boxWithText(page, 100, 100, 'upper')
  const b = await boxWithText(page, 100, 400, 'lower')
  await moveBoxTo(page, b, a, 10, 10)
  const bg = await b.locator('.slate-box-body').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).not.toBe('rgba(0, 0, 0, 0)')
})

test('clicking a box brings it to the front, and the order survives a restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  const a = await boxWithText(first.page, 100, 100, 'box a')
  const b = await boxWithText(first.page, 100, 400, 'box b')
  const aId = await a.getAttribute('data-box-id')
  await moveBoxTo(first.page, b, a, 30, 8)
  // B is on top (newest); click the visible part of A (its left edge) to raise A.
  const ar = await rect(a)
  await first.page.mouse.click(ar.x + 10, ar.y + ar.height - 4)
  const topAt = (p: typeof first.page) =>
    p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.slate-box')?.getAttribute('data-box-id'), { x: ar.x + 50, y: ar.y + 12 })
  await expect.poll(() => topAt(first.page)).toBe(aId)
  await first.page.waitForTimeout(300)
  await first.app.close()
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('box')).toHaveCount(2)
  await expect.poll(() => topAt(second.page)).toBe(aId)
  await second.app.close()
})

test('Re-arrange boxes removes overlaps in one undo step', async ({ page }) => {
  const a = await boxWithText(page, 100, 100, 'first box\nline two\nline three')
  const b = await boxWithText(page, 100, 400, 'second box')
  const c = await boxWithText(page, 700, 100, 'apart')
  await moveBoxTo(page, b, a, 60, 20)
  const before = { a: await rect(a), b: await rect(b), c: await rect(c) }
  expect(overlap(before.a, before.b)).toBe(true)
  const canvas = page.getByTestId('canvas')
  const cr = await rect(canvas)
  await page.mouse.click(cr.x + 30, cr.y + 40, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Re-arrange boxes' }).click()
  await expect.poll(async () => overlap(await rect(a), await rect(b))).toBe(false)
  expect(await rect(a)).toEqual(before.a)
  expect(await rect(c)).toEqual(before.c)
  expect(Math.round((await rect(b)).x)).toBe(Math.round(before.b.x))
  await canvas.focus()
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(async () => Math.round((await rect(b)).y)).toBe(Math.round(before.b.y))
})

test('Re-arrange boxes is disabled when nothing overlaps', async ({ page }) => {
  await boxWithText(page, 100, 100, 'one')
  await boxWithText(page, 700, 100, 'two')
  const cr = await rect(page.getByTestId('canvas'))
  await page.mouse.click(cr.x + 30, cr.y + 40, { button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Re-arrange boxes' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('canvas-menu')).toHaveCount(0)
})
