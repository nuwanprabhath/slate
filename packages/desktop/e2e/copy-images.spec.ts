import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const writePng = (app: ElectronApplication) =>
  app.evaluate(({ clipboard, ClipboardItem }, url) => {
    const bytes = Uint8Array.from(atob(url.split(',')[1]!), (c) => c.charCodeAt(0))
    return clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, PNG)

/** As a person does it: caret at the start, shift+click at the end. */
async function selectAcross(page: Page, box: Locator) {
  await box.locator('p').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.down('Shift')
  await box.locator('p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.up('Shift')
  // The editor reads a mouse selection from the browser's selectionchange, a moment later.
  await expect(box.locator('img.slate-image-selected')).toHaveCount(1)
}

const clipboardHtml = (app: ElectronApplication) =>
  app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read()
    return item?.types.includes('text/html') ? (await item.getType('text/html')).text() : ''
  })

async function boxWithTextAndImage(app: ElectronApplication, page: Page) {
  await createBoxAt(page, 120, 120)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type('Before')
  await writePng(app)
  await page.keyboard.press(`${MOD}+v`)
  const box = page.getByTestId('box-editor').first()
  await expect(box.locator('img')).toHaveCount(1)
  await page.keyboard.type('After')
  return box
}

test('copying text with a picture puts the picture itself on the clipboard, for other apps', async ({ app, page }) => {
  const box = await boxWithTextAndImage(app, page)
  await selectAcross(page, box)
  await page.keyboard.press(`${MOD}+c`)
  await expect.poll(() => clipboardHtml(app)).toMatch(/Before[\s\S]*<img src="data:image\/png;base64,[^"]+"[\s\S]*After/)
  expect(await clipboardHtml(app)).not.toContain('slate-blob:')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Before\nAfter')

  // Pasted back into Slate, the picture is stored again: the page holds an address, not the bytes.
  await page.keyboard.press('ArrowRight')
  await expect(box.locator('img.slate-image-selected')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+v`)
  await expect(box.locator('img')).toHaveCount(2)
  for (const img of await box.locator('img').all()) await expect(img).toHaveAttribute('src', /^slate-blob:\/\/blob\//)
  await expect(box).toContainText('AfterBefore')
})

test('cutting text with a picture takes it out of the box', async ({ app, page }) => {
  const box = await boxWithTextAndImage(app, page)
  await selectAcross(page, box)
  await page.keyboard.press(`${MOD}+x`)
  await expect.poll(() => clipboardHtml(app)).toContain('data:image/png;base64,')
  await expect(box.locator('img')).toHaveCount(0)
})
