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

/** Where the picture is drawn, relative to its box's text area. */
const placed = async (box: import('@playwright/test').Locator) => {
  const img = (await box.locator('img').boundingBox())!
  const area = (await box.getByTestId('box-editor').boundingBox())!
  return { x: img.x - area.x, y: img.y - area.y, img }
}

const order = (box: import('@playwright/test').Locator) =>
  box.locator('[data-testid="box-editor"] > *').evaluateAll((els) => els.map((el) => (el.nodeName === 'IMG' ? 'IMG' : el.textContent)))

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
  // Selected through the editor: key presses right after the click that focuses the box can be lost.
  await box.getByTestId('box-editor').evaluate((el) => {
    type Chain = { focus: () => Chain; setTextSelection: (r: { from: number; to: number }) => Chain; run: () => boolean }
    const editor = (el as HTMLElement & { editor: { state: import('@tiptap/pm/state').EditorState; chain: () => Chain } }).editor
    const end = 1 + editor.state.doc.firstChild!.content.size
    editor.chain().focus().setTextSelection({ from: end - 'Move me'.length, to: end }).run()
  })
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

test('a picture dragged out of a box holding only it takes the box along, and one undo brings both back', async ({ app, page }) => {
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 200
    c.height = 100
    c.getContext('2d')!.fillRect(0, 0, 200, 100)
    return c.toDataURL('image/png')
  })
  await app.evaluate(({ clipboard, ClipboardItem }, url) => {
    const bytes = Uint8Array.from(atob(url.split(',')[1]!), (ch) => ch.charCodeAt(0))
    return clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, png)
  // A picture pasted on the bare canvas lands in a box of its own.
  await page.getByTestId('canvas').click({ position: { x: 80, y: 80 } })
  await page.keyboard.press(`${MOD}+v`)
  const alone = page.locator('.slate-box').filter({ has: page.locator('img') })
  await expect(alone.locator('img')).toHaveCount(1)
  await expect(alone.locator('p')).toHaveCount(0)
  const other = await boxWithText(page, 60, 400, 'Other box text')
  const img = (await alone.locator('img').boundingBox())!
  const text = (await other.locator('p').last().boundingBox())!
  await drag(page, { x: img.x + 100, y: img.y + 50 }, { x: text.x + 40, y: text.y + text.height / 2 })
  await expect(other.locator('img')).toHaveCount(1)
  await expect(page.locator('.slate-box')).toHaveCount(1)

  await page.keyboard.press(`${MOD}+z`)
  await expect(page.locator('.slate-box')).toHaveCount(2)
  await expect(other.locator('img')).toHaveCount(0)
  await expect(page.locator('.slate-box img')).toHaveCount(1)
})

test('a picture dragged sideways along its line floats where it is let go', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const before = await placed(box)
  await drag(page, { x: before.img.x + 100, y: before.img.y + 60 }, { x: before.img.x + 300, y: before.img.y + 60 })
  await expect(box.locator('img[data-x]')).toHaveCount(1)
  const after = await placed(box)
  expect(Math.abs(after.x - (before.x + 200))).toBeLessThan(3)
  expect(Math.abs(after.y - before.y)).toBeLessThan(3)
  // Still a picture in the text for copies and older versions: only its place in the box changed.
  await expect.poll(() => order(box)).toEqual(['Text above the picture', 'IMG', 'Text below the picture'])
})

test('a picture dropped over the text sits on top of it, the text unchanged, and one undo puts it back in the text', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = (await box.locator('img').boundingBox())!
  const line = (await box.locator('p').first().boundingBox())!
  await drag(page, { x: img.x + 100, y: img.y + 60 }, { x: img.x + 300, y: line.y + 4 + 60 })
  await expect(box.locator('img[data-x]')).toHaveCount(1)
  const now = (await box.locator('img').boundingBox())!
  expect(now.y).toBeLessThan(line.y + line.height)
  expect(now.x).toBeGreaterThan(img.x + 150)
  await expect(box.locator('p').first()).toHaveText('Text above the picture')
  await expect(box.locator('p').last()).toHaveText('Text below the picture')

  await page.keyboard.press(`${MOD}+z`)
  await expect(box.locator('img[data-x]')).toHaveCount(0)
  await expect(box.locator('img')).toHaveCount(1)
})

test('a picture dragged down past the text makes the box grow to hold it', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = (await box.locator('img').boundingBox())!
  const height = (await box.boundingBox())!.height
  await drag(page, { x: img.x + 100, y: img.y + 60 }, { x: img.x + 100, y: img.y + 60 + 50 })
  await expect(box.locator('img[data-x]')).toHaveCount(1)
  const now = (await box.locator('img').boundingBox())!
  expect(Math.abs(now.y - (img.y + 50))).toBeLessThan(3)
  await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan(height + 20)
  const editor = (await box.getByTestId('box-editor').boundingBox())!
  expect(editor.y + editor.height).toBeGreaterThanOrEqual(now.y + now.height)
})

test('in a box made taller than its text, a picture dropped in the empty space below floats there', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  await page.locator('.slate-box').first().evaluate((el: HTMLElement) => {
    el.style.height = '520px'
  })
  const img = (await box.locator('img').boundingBox())!
  const last = (await box.locator('p').last().boundingBox())!
  const to = { x: img.x + 160, y: last.y + last.height + 150 }
  await drag(page, { x: img.x + 100, y: img.y + 60 }, to)
  await expect(box.locator('img[data-x]')).toHaveCount(1)
  const now = (await box.locator('img').boundingBox())!
  expect(Math.abs(now.x - (to.x - 100))).toBeLessThan(3)
  expect(Math.abs(now.y - (to.y - 60))).toBeLessThan(3)
})
