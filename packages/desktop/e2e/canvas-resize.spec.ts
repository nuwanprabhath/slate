import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, launchApp, MOD, test } from './fixtures'
import { boxWithText, drag, rect } from './canvasHelpers'

async function pull(page: Page, box: Locator, testId: string, dx: number, dy: number) {
  await box.hover()
  const r = await rect(box.getByTestId(testId))
  const from = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  await drag(page, from, { x: from.x + dx, y: from.y + dy })
}

const round = (r: { x: number; y: number; width: number; height: number }) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })

test('the left edge resizes width and x together; the right edge stays put', async ({ page }) => {
  const a = await boxWithText(page, 300, 100, 'left edge')
  const before = round(await rect(a))
  await pull(page, a, 'box-resize-left', -100, 0)
  await expect.poll(async () => round(await rect(a)).x).toBe(before.x - 100)
  expect(round(await rect(a)).width).toBe(before.width + 100)
  await pull(page, a, 'box-resize-left', 1000, 0)
  // Never below the minimum width; the right edge still where it was.
  await expect.poll(async () => round(await rect(a)).width).toBe(120)
  const after = round(await rect(a))
  expect(after.x + after.width).toBe(before.x + before.width)
})

test('the bottom edge sets a min height, never below the content, and undo restores it', async ({ page }) => {
  const a = await boxWithText(page, 100, 100, 'bottom edge')
  const before = round(await rect(a))
  await pull(page, a, 'box-resize-bottom', 0, 120)
  await expect.poll(async () => round(await rect(a)).height).toBe(before.height + 120)
  // Typing still grows it only when the content outgrows the min height; it stays at least that tall.
  await a.locator('.slate-box-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' more')
  expect(round(await rect(a)).height).toBe(before.height + 120)
  await pull(page, a, 'box-resize-bottom', 0, -400)
  await expect.poll(async () => round(await rect(a)).height).toBe(before.height)
  await page.getByTestId('canvas').focus()
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(async () => round(await rect(a)).height).toBe(before.height + 120)
})

test('the corners resize both ways', async ({ page }) => {
  const a = await boxWithText(page, 300, 100, 'corners')
  const before = round(await rect(a))
  await pull(page, a, 'box-resize-se', 60, 80)
  await expect.poll(async () => round(await rect(a)).width).toBe(before.width + 60)
  expect(round(await rect(a)).height).toBe(before.height + 80)
  expect(round(await rect(a)).x).toBe(before.x)
  await pull(page, a, 'box-resize-sw', -50, 40)
  await expect.poll(async () => round(await rect(a)).x).toBe(before.x - 50)
  expect(round(await rect(a)).width).toBe(before.width + 110)
  expect(round(await rect(a)).height).toBe(before.height + 120)
})

test('resize cursors are the edge cursors', async ({ page }) => {
  const a = await boxWithText(page, 300, 100, 'cursors')
  const cursor = (id: string) => a.getByTestId(id).evaluate((el) => getComputedStyle(el).cursor)
  expect(await cursor('box-resize')).toBe('ew-resize')
  expect(await cursor('box-resize-left')).toBe('ew-resize')
  expect(await cursor('box-resize-bottom')).toBe('ns-resize')
  expect(await cursor('box-resize-se')).toBe('nwse-resize')
  expect(await cursor('box-resize-sw')).toBe('nesw-resize')
})

test('a taller box pushes the box below it', async ({ page }) => {
  const a = await boxWithText(page, 100, 100, 'top')
  const b = await boxWithText(page, 100, 260, 'below')
  const before = round(await rect(b))
  await pull(page, a, 'box-resize-bottom', 0, 200)
  await expect.poll(async () => round(await rect(b)).y).toBeGreaterThan(before.y + 100)
})

test('left, bottom and corner resizes persist across restarts', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  const a = await boxWithText(first.page, 300, 100, 'persist')
  await pull(first.page, a, 'box-resize-left', -80, 0)
  await pull(first.page, a, 'box-resize-se', 0, 100)
  const saved = round(await rect(a))
  await first.page.waitForTimeout(300)
  await first.app.close()
  const second = await launchApp(userData)
  const box = second.page.getByTestId('box')
  await expect(box).toHaveCount(1)
  await expect.poll(async () => round(await rect(box))).toEqual(saved)
  await second.app.close()
})
