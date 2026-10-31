import type { Page } from '@playwright/test'
import { boxWithText } from './canvasHelpers'
import { expect, MOD, test } from './fixtures'
import { boxWithImage } from './imageHelpers'

type Point = { x: number; y: number }

/** Presses on `from`, moves past the drag threshold, then to `to` and lets go. */
async function drag(page: Page, from: Point, to: Point, opts: { copy?: boolean } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 })
  if (opts.copy) await page.keyboard.down(process.platform === 'darwin' ? 'Alt' : 'Control')
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
  if (opts.copy) await page.keyboard.up(process.platform === 'darwin' ? 'Alt' : 'Control')
}

const order = (box: import('@playwright/test').Locator) =>
  box.locator('[data-testid="box-editor"] > *').evaluateAll((els) => els.map((el) => (el.nodeName === 'IMG' ? 'IMG' : el.textContent)))

test('a picture dragged within its box moves below the text after it', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = (await box.locator('img').boundingBox())!
  const below = (await box.locator('p').last().boundingBox())!
  await drag(page, { x: img.x + 100, y: img.y + 60 }, { x: below.x + below.width - 2, y: below.y + below.height / 2 })
  await expect.poll(() => order(box)).toEqual(['Text above the picture', 'Text below the picture', 'IMG'])
})

test('a picture dragged into another box moves there, and one undo puts it back', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const other = await boxWithText(page, 60, 360, 'Other box text')
  const img = (await box.locator('img').boundingBox())!
  const text = (await other.locator('p').last().boundingBox())!
  await drag(page, { x: img.x + 100, y: img.y + 60 }, { x: text.x + text.width - 2, y: text.y + text.height / 2 })
  await expect(other.locator('img')).toHaveCount(1)
  await expect(box.locator('img')).toHaveCount(0)
  await expect(box).toContainText('Text below the picture')

  await page.keyboard.press(`${MOD}+z`)
  await expect(box.locator('img')).toHaveCount(1)
  await expect(other.locator('img')).toHaveCount(0)
})

test('Option (Ctrl) held at the drop copies the picture into the other box', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const other = await boxWithText(page, 60, 360, 'Other box text')
  const img = (await box.locator('img').boundingBox())!
  const text = (await other.locator('p').last().boundingBox())!
  await drag(page, { x: img.x + 100, y: img.y + 60 }, { x: text.x + text.width - 2, y: text.y + text.height / 2 }, { copy: true })
  await expect(other.locator('img')).toHaveCount(1)
  await expect(box.locator('img')).toHaveCount(1)
})

test('a picture dropped on the bare canvas lands in a new box there', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = (await box.locator('img').boundingBox())!
  const canvas = (await page.getByTestId('canvas').boundingBox())!
  await drag(page, { x: img.x + 100, y: img.y + 60 }, { x: canvas.x + 700, y: canvas.y + 420 })
  await expect(page.locator('.slate-box')).toHaveCount(2)
  const added = page.locator('.slate-box').filter({ hasNot: page.getByText('Text above the picture') })
  await expect(added.locator('img')).toHaveCount(1)
  await expect(box.locator('img')).toHaveCount(0)
  const at = (await added.boundingBox())!
  expect(Math.abs(at.x - (canvas.x + 700))).toBeLessThan(30)
  expect(Math.abs(at.y - (canvas.y + 420))).toBeLessThan(40)
})

test('selected text dragged into another box moves there', async ({ page }) => {
  const box = await boxWithText(page, 60, 60, 'Keep this. Move me')
  const other = await boxWithText(page, 60, 260, 'Target')
  await box.locator('p').first().click()
  await page.keyboard.press('End')
  for (let i = 0; i < 'Move me'.length; i++) await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Move me')
  // Playwright's mouse cannot start a text drag (not even in a bare contenteditable): the browser's drag events are sent as Chromium sends them.
  await page.evaluate((ids) => {
    const [fromBox, toBox] = ids.map((id) => document.querySelector(`[data-box-id="${id}"] [data-testid="box-editor"]`)!)
    const words = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
    const target = toBox!.querySelector('p')!.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    const at = (x: number, y: number) => ({ bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y })
    fromBox!.dispatchEvent(new DragEvent('dragstart', at(words.x + words.width / 2, words.y + words.height / 2)))
    toBox!.dispatchEvent(new DragEvent('dragover', at(target.x + 20, target.y + target.height / 2)))
    toBox!.querySelector('p')!.dispatchEvent(new DragEvent('drop', at(target.x + 20, target.y + target.height / 2)))
    fromBox!.dispatchEvent(new DragEvent('dragend', at(target.x + 20, target.y + target.height / 2)))
  }, [await box.getAttribute('data-box-id'), await other.getAttribute('data-box-id')])
  await expect(other).toContainText('Move me')
  await expect(box.locator('p').first()).toHaveText('Keep this. ')
})
