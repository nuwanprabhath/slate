import { expect, MOD, test } from './fixtures'
import { boxWithText, drag, rect } from './canvasHelpers'

test('Cmd/Ctrl+click selects boxes, a handle drag moves them all in one undo step, Escape clears', async ({ page }) => {
  const a = await boxWithText(page, 60, 60, 'alpha')
  const b = await boxWithText(page, 60, 260, 'beta')
  const c = await boxWithText(page, 620, 60, 'gamma')
  await a.getByTestId('box-handle').click({ modifiers: [MOD === 'Meta' ? 'Meta' : 'Control'] })
  await b.getByTestId('box-handle').click({ modifiers: [MOD === 'Meta' ? 'Meta' : 'Control'] })
  await expect(a).toHaveAttribute('aria-selected', 'true')
  await expect(b).toHaveAttribute('aria-selected', 'true')
  await expect(c).toHaveAttribute('aria-selected', 'false')
  const before = { a: await rect(a), b: await rect(b), c: await rect(c) }
  const h = await rect(b.getByTestId('box-handle'))
  await drag(page, { x: h.x + 20, y: h.y + 9 }, { x: h.x + 120, y: h.y + 59 })
  await expect.poll(async () => Math.round((await rect(a)).x - before.a.x)).toBe(100)
  expect(Math.round((await rect(a)).y - before.a.y)).toBe(50)
  expect(Math.round((await rect(b)).x - before.b.x)).toBe(100)
  expect(Math.round((await rect(b)).y - before.b.y)).toBe(50)
  expect(await rect(c)).toEqual(before.c)
  // Still selected after the move; Escape clears.
  await expect(a).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(a).toHaveAttribute('aria-selected', 'false')
  await expect(b).toHaveAttribute('aria-selected', 'false')
  // One undo puts both back.
  await page.getByTestId('canvas').focus()
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(async () => Math.round((await rect(a)).x)).toBe(Math.round(before.a.x))
  expect(Math.round((await rect(b)).x)).toBe(Math.round(before.b.x))
})

test('Cmd/Ctrl+click toggles, a click on empty canvas or a plain click on a box clears', async ({ page }) => {
  const mod = MOD === 'Meta' ? 'Meta' : 'Control'
  const a = await boxWithText(page, 60, 60, 'alpha')
  const b = await boxWithText(page, 60, 260, 'beta')
  await a.getByTestId('box-handle').click({ modifiers: [mod] })
  await b.getByTestId('box-handle').click({ modifiers: [mod] })
  await b.getByTestId('box-handle').click({ modifiers: [mod] })
  await expect(a).toHaveAttribute('aria-selected', 'true')
  await expect(b).toHaveAttribute('aria-selected', 'false')
  await page.getByTestId('canvas').click({ position: { x: 20, y: 500 } })
  await expect(a).toHaveAttribute('aria-selected', 'false')
  await a.getByTestId('box-handle').click({ modifiers: [mod] })
  await b.getByTestId('box-handle').click({ modifiers: [mod] })
  await b.locator('.slate-box-content').click()
  await expect(a).toHaveAttribute('aria-selected', 'false')
  await expect(b).toHaveAttribute('aria-selected', 'false')
})

test('Delete removes the selected boxes in one undo step, and never text', async ({ page }) => {
  const mod = MOD === 'Meta' ? 'Meta' : 'Control'
  const a = await boxWithText(page, 60, 60, 'alpha')
  const b = await boxWithText(page, 60, 260, 'beta')
  await a.getByTestId('box-handle').click({ modifiers: [mod] })
  await b.locator('.slate-box-content').click({ modifiers: [mod] })
  await expect(b).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Backspace')
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('box')).toHaveCount(2)
  await expect(page.getByTestId('box').filter({ hasText: 'alpha' })).toHaveCount(1)
  await expect(page.getByTestId('box').filter({ hasText: 'beta' })).toHaveCount(1)
})
