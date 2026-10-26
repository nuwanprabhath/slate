import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function newBox(page: Page, x = 120, y = 120) {
  await createBoxAt(page, x, y)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
}

const caretRect = (page: Page) =>
  page.evaluate(() => {
    const r = window.getSelection()!.getRangeAt(0)
    const rects = r.getClientRects()
    const node = r.startContainer.nodeType === 3 ? r.startContainer.parentElement! : (r.startContainer as HTMLElement)
    // An empty line has no text to measure: its paragraph's line box is where the caret is drawn.
    const rect = rects.length ? rects[0]! : (node.closest('p') ?? node).getBoundingClientRect()
    return { height: rect.height, fontSize: parseFloat(getComputedStyle(node).fontSize) }
  })

for (const where of ['after typing', 'in a fresh line']) {
  test(`the caret is as tall as the chosen font size (${where})`, async ({ page }) => {
    await newBox(page)
    await page.keyboard.type('big text')
    await page.keyboard.press(`${MOD}+a`)
    await page.getByTestId('tb-size').selectOption('32px')
    await page.getByTestId('tb-font').selectOption('monospace')
    // Under load the toolbar's change can land after the keys below; the text must be styled first.
    await expect(page.locator('[data-testid="box-editor"] [style*="32px"]').first()).toBeVisible()
    await page.locator('[data-testid="box-editor"]').focus()
    await page.keyboard.press('End')
    if (where === 'in a fresh line') await page.keyboard.press('Enter')
    // The caret is measured once the browser has laid the new line out, which can take frames.
    await expect.poll(async () => (await caretRect(page)).height).toBeGreaterThanOrEqual(32 * 0.9)
  })
}

test('the pending caret follows the text size of the canvas', async ({ page }) => {
  await page.getByTestId('canvas').click({ position: { x: 200, y: 200 } })
  const caret = page.locator('.slate-pending-caret')
  await expect(caret).toBeVisible()
  const fontSize = await caret.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const h = (await caret.boundingBox())!.height
  expect(h).toBeGreaterThanOrEqual(fontSize * 0.9)
})

const writePng = (app: ElectronApplication, dataUrl: string) =>
  app.evaluate(({ clipboard, ClipboardItem }, url) => {
    const bytes = Uint8Array.from(atob(url.split(',')[1]!), (c) => c.charCodeAt(0))
    return clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, dataUrl)

test('after pasting an image the caret is a text caret, not a gap cursor underline', async ({ app, page }) => {
  await newBox(page)
  await page.keyboard.type('A')
  await writePng(app, PNG)
  await page.keyboard.press(`${MOD}+v`)
  const img = page.locator('[data-testid="box-editor"] img')
  await expect(img).toHaveCount(1)
  await expect(page.locator('.ProseMirror-gapcursor')).toHaveCount(0)
  const sel = await page.evaluate(() => {
    const s = window.getSelection()!
    const n = s.anchorNode
    const el = n && n.nodeType === 3 ? n.parentElement! : (n as HTMLElement)
    return { collapsed: s.isCollapsed, tag: el.closest('p') ? 'p' : el.tagName, selectedImg: !!document.querySelector('img.ProseMirror-selectednode') }
  })
  expect(sel).toEqual({ collapsed: true, tag: 'p', selectedImg: false })
  // the last block is an empty paragraph after the image
  await expect(page.locator('[data-testid="box-editor"] > *').last()).toHaveJSProperty('tagName', 'P')
})

test('Delete on a focused box header deletes the box, and undo brings it back', async ({ page }) => {
  await newBox(page)
  await page.keyboard.type('keep me')
  await page.keyboard.press('Escape')
  const box = page.getByTestId('box')
  await box.hover()
  await box.getByTestId('box-handle').click()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.getByTestId('canvas').focus()
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box')).toContainText('keep me')
})

test('Backspace inside the box text does not delete the box', async ({ page }) => {
  await newBox(page)
  await page.keyboard.type('ab')
  await page.keyboard.press('Backspace')
  await expect(page.getByTestId('box')).toContainText('a')
  await expect(page.getByTestId('box')).toHaveCount(1)
})
