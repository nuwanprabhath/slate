import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, MOD, test } from '../fixtures'
import { boxWithText, moveBoxTo, rect } from '../canvasHelpers'
import { reviewUi } from './review'

const mod = MOD === 'Meta' ? 'Meta' : 'Control'

/** Two overlapping boxes: the front one's body hides the back one's text, the back one's handle shows above it. */
test('UI: canvas with overlapping boxes', async ({ app, page }) => {
  const a = await boxWithText(page, 60, 60, 'The upper box, in front.\nIts body is opaque, so the text below does not show through.')
  const b = await boxWithText(page, 60, 300, 'The lower box, behind. Its handle sits inside the upper box.')
  await moveBoxTo(page, b, a, 40, 30)
  await a.locator('.slate-box-content').click({ position: { x: 5, y: 5 } })
  await reviewUi(app, page, 'canvas overlapping boxes', {
    open: async (p) => {
      const h = await rect(b.getByTestId('box-handle'))
      await p.mouse.move(h.x + 40, h.y + 9)
      await expect(b.locator('.slate-box-bar')).toHaveCSS('opacity', '1')
    },
  })
})

test('UI: canvas with two boxes selected', async ({ app, page }) => {
  const a = await boxWithText(page, 60, 60, 'Selected box one')
  const b = await boxWithText(page, 60, 220, 'Selected box two')
  await boxWithText(page, 600, 60, 'Not selected')
  await a.getByTestId('box-handle').click({ modifiers: [mod] })
  await b.getByTestId('box-handle').click({ modifiers: [mod] })
  await expect(b).toHaveAttribute('aria-selected', 'true')
  await reviewUi(app, page, 'canvas selection')
})

test('UI: canvas context menu', async ({ app, page }) => {
  const a = await boxWithText(page, 80, 80, 'One box')
  const b = await boxWithText(page, 80, 300, 'Another box, overlapping it')
  await moveBoxTo(page, b, a, 30, 10)
  await reviewUi(app, page, 'canvas context menu', {
    open: async (p) => {
      const c = await rect(p.getByTestId('canvas'))
      await p.mouse.click(c.x + 30, c.y + 30, { button: 'right' })
      await expect(p.getByTestId('arrange-boxes')).toBeEnabled()
    },
    close: async (p) => {
      await p.keyboard.press('Escape')
      await expect(p.getByTestId('canvas-menu')).toHaveCount(0)
    },
  })
})

/** A box of text around a pasted picture, for the selected-image states. */
async function boxWithImage(app: ElectronApplication, page: Page): Promise<Locator> {
  const box = await boxWithText(page, 60, 60, 'Text above the picture')
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 240
    c.height = 120
    const g = c.getContext('2d')!
    g.fillStyle = '#6a8caf'
    g.fillRect(0, 0, 240, 120)
    g.fillStyle = '#f2d16b'
    g.fillRect(150, 20, 60, 60)
    return c.toDataURL('image/png')
  })
  await app.evaluate(({ clipboard, ClipboardItem }, url) => {
    const bytes = Uint8Array.from(atob(url.split(',')[1]!), (ch) => ch.charCodeAt(0))
    return clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, png)
  await page.keyboard.press('End')
  await page.keyboard.press(`${MOD}+v`)
  await expect(box.locator('img')).toHaveCount(1)
  await page.keyboard.type('Text below the picture')
  return box
}

const ringWidth = (img: Locator) => img.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth))

test('UI: an image inside a shift+click selection, and a clicked image', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = box.locator('img')
  const lines = box.locator('.slate-box-content p')
  await reviewUi(app, page, 'image in a text selection', {
    open: async (p) => {
      // The maintainer's report: caret after the first line, shift+click on the line under the picture.
      const above = await rect(lines.first())
      const below = await rect(lines.last())
      await p.mouse.click(above.x + 20, above.y + above.height / 2)
      await p.keyboard.press('End')
      await p.keyboard.down('Shift')
      await p.mouse.click(below.x + 4, below.y + below.height / 2)
      await p.keyboard.up('Shift')
      await expect(img).toHaveClass(/slate-image-selected/)
      expect(await ringWidth(img)).toBeGreaterThanOrEqual(3)
    },
  })
  await reviewUi(app, page, 'clicked image', {
    open: async (p) => {
      await img.click()
      await expect(img).toHaveClass(/ProseMirror-selectednode/)
      expect(await ringWidth(img)).toBeGreaterThanOrEqual(3)
      await p.mouse.move(1, 1)
    },
  })
})

test('UI: a box marked for cut', async ({ app, page }) => {
  const a = await boxWithText(page, 60, 60, 'This box is cut: a paste moves it.')
  await boxWithText(page, 60, 240, 'This box stays where it is.')
  await a.hover()
  await a.getByTestId('box-handle').click()
  await page.keyboard.press(`${MOD}+x`)
  await expect(a).toHaveClass(/is-cut/)
  await page.mouse.move(1, 1)
  await reviewUi(app, page, 'box marked for cut')
})

test('UI: pasted boxes', async ({ app, page }) => {
  const a = await boxWithText(page, 60, 60, 'First copied box')
  const b = await boxWithText(page, 60, 200, 'Second copied box')
  await a.getByTestId('box-handle').click({ modifiers: [mod] })
  await b.getByTestId('box-handle').click({ modifiers: [mod] })
  await page.keyboard.press(`${MOD}+c`)
  await page.getByTestId('canvas').click({ position: { x: 360, y: 360 } })
  await page.keyboard.press(`${MOD}+v`)
  await expect(page.getByTestId('box')).toHaveCount(4)
  await expect(page.locator('[data-testid="box"][aria-selected="true"]')).toHaveCount(2)
  await page.mouse.move(1, 1)
  await reviewUi(app, page, 'pasted boxes')
})
