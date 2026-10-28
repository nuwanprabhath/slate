import type { Locator, Page } from '@playwright/test'
import { createBoxAt, expect } from './fixtures'

/** Makes a box at (x, y) on the canvas, types `text` in it and returns its locator (by box id). */
export async function boxWithText(page: Page, x: number, y: number, text: string): Promise<Locator> {
  await createBoxAt(page, x, y)
  const editor = page.locator('[data-testid="box-editor"]:focus')
  await expect(editor).toHaveText('')
  await page.keyboard.type(text)
  const id = await page.locator('.slate-box:focus-within').getAttribute('data-box-id')
  return page.locator(`[data-box-id="${id!}"]`)
}

/** Drags from one page point to another with the mouse, in steps like a person. */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, modifiers: string[] = []): Promise<void> {
  for (const m of modifiers) await page.keyboard.down(m)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  for (const m of modifiers) await page.keyboard.up(m)
}

export async function rect(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const r = await l.boundingBox()
  expect(r).not.toBeNull()
  return r!
}

/** Moves box `b` by dragging its handle so its top-left lands at (dx, dy) from `anchor`'s top-left. */
export async function moveBoxTo(page: Page, b: Locator, anchor: Locator, dx: number, dy: number): Promise<void> {
  // Hovering can scroll the canvas, so measure only after it.
  await b.hover()
  const h = await rect(b.getByTestId('box-handle'))
  const r = await rect(b)
  const to = await rect(anchor)
  await drag(page, { x: h.x + 10, y: h.y + 5 }, { x: to.x + dx + 10 + (h.x - r.x), y: to.y + dy + 5 + (h.y - r.y) })
  await expect.poll(async () => Math.round((await rect(b)).y - (await rect(anchor)).y)).toBe(dy)
}

/** Whether two page rectangles overlap. */
export function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
