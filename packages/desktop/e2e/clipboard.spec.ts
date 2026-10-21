import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt,expect, MOD, test } from './fixtures'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function newBox(page: Page, x = 120, y = 120) {
  await createBoxAt(page, x, y)
  // Wait for the NEW (empty) box to own focus: DOM order is by random box id, so .last() may be an old box.
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
}
const copy = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy())
const paste = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste())

// Electron 45's clipboard is the async W3C-style API: ClipboardItem in, promises out.
const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText())
const writeText = (app: ElectronApplication, text: string) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
const writeHtml = (app: ElectronApplication, html: string, text: string) =>
  app.evaluate(
    ({ clipboard, ClipboardItem }, data) =>
      clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([data.html], { type: 'text/html' }),
          'text/plain': new Blob([data.text], { type: 'text/plain' }),
        }),
      ]),
    { html, text },
  )
const writePng = (app: ElectronApplication, dataUrl: string) =>
  app.evaluate(({ clipboard, ClipboardItem }, url) => {
    const bytes = Uint8Array.from(Buffer.from(url.split(',')[1], 'base64'))
    return clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, dataUrl)
const clipboardHasImage = (app: ElectronApplication) =>
  app.evaluate(async ({ clipboard }) => (await clipboard.read()).some((item) => item.types.some((t) => t.startsWith('image/'))))
const clearClipboard = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.clear())

test('copying a nested numbered list gives real numbers and no stray characters', async ({ app, page }) => {
  await newBox(page)
  await page.keyboard.press(`${MOD}+Shift+7`)
  await page.keyboard.type('one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('a')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.type('three')
  await page.keyboard.press(`${MOD}+a`)
  await copy(app)
  await expect.poll(() => clipboardText(app)).toBe('1. one\n2. two\n  1. a\n3. three')
})

test('default paste keeps bold but drops source fonts, sizes and colours', async ({ app, page }) => {
  await newBox(page)
  await writeHtml(
    app,
    '<meta charset="utf-8"><p><span style="font-family:Comic Sans MS;color:red;font-size:30px">Hello</span> <b>world</b></p>',
    'Hello world',
  )
  await paste(app)
  const editor = page.getByTestId('box-editor')
  await expect(editor).toContainText('Hello world')
  const html = await editor.innerHTML()
  expect(html).toContain('<strong>world</strong>')
  expect(html).not.toMatch(/font-family|font-size|color/)
})

test('Mod+Shift+V pastes plain text', async ({ app, page }) => {
  await newBox(page)
  await writeHtml(app, '<p><b>bold</b> text</p>', 'bold text')
  await page.keyboard.press(`${MOD}+Shift+V`)
  const editor = page.getByTestId('box-editor')
  await expect(editor).toContainText('bold text')
  expect(await editor.innerHTML()).not.toContain('<strong>')
})

test('pasted images are stored as blobs and can be copied back out', async ({ app, page }) => {
  await newBox(page)
  await writePng(app, PNG)
  await paste(app)
  const img = page.locator('[data-testid="box-editor"] img')
  await expect(img).toHaveAttribute('src', /^slate-blob:\/\/blob\/[a-f0-9]{64}\.png$/)
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await clearClipboard(app)
  await img.click()
  await copy(app)
  await expect.poll(() => clipboardHasImage(app)).toBe(true)
})

test('pasting with no box focused creates a new box', async ({ app, page }) => {
  // The canvas's paste listener attaches after React mounts; without this the key can land first.
  await expect(page.getByTestId('canvas')).toBeVisible()
  await writeText(app, 'line one\nline two')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // webContents.paste() sends nothing when no editable is focused; Mod+V is the path a real user takes.
  await page.keyboard.press(`${MOD}+v`)
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box')).toContainText('line two')
})
