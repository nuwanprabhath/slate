import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

/** A box taller than its text (a resized box), holding text, then "a", a picture and an empty line. */
async function tallBoxWithPicture(app: ElectronApplication, page: Page) {
  await createBoxAt(page, 60, 40)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 160
    c.height = 110
    const g = c.getContext('2d')!
    g.fillStyle = '#6a8caf'
    g.fillRect(0, 0, 160, 110)
    return c.toDataURL('image/png')
  })
  await page.keyboard.type('Text above.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('a')
  await page.keyboard.press('Enter')
  await app.evaluate(({ clipboard, ClipboardItem }, url) => {
    const bytes = Uint8Array.from(atob(url.split(',')[1]!), (ch) => ch.charCodeAt(0))
    return clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, png)
  await page.keyboard.press(`${MOD}+v`)
  const box = page.getByTestId('box-editor').first()
  await expect(box.locator('img')).toHaveCount(1)
  await page.locator('.slate-box').first().evaluate((el: HTMLElement) => {
    el.style.height = '520px'
  })
  return box
}

test('shift+click in the empty space below a box text selects through to the end, picture included', async ({ app, page }) => {
  const box = await tallBoxWithPicture(app, page)
  const a = (await box.locator('p', { hasText: /^a$/ }).boundingBox())!
  const img = (await box.locator('img').boundingBox())!
  await page.mouse.click(a.x + 2, a.y + a.height / 2)
  await page.keyboard.press('Home')
  await page.keyboard.down('Shift')
  await page.mouse.click(a.x + 60, img.y + img.height + 150)
  await page.keyboard.up('Shift')
  await expect(box.locator('img.slate-image-selected')).toHaveCount(1)
  // Nothing above the "a" line is selected.
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toContain('Text above')
})

test('a click in the empty space below a box text puts the caret at its end', async ({ app, page }) => {
  const box = await tallBoxWithPicture(app, page)
  const img = (await box.locator('img').boundingBox())!
  await page.getByTestId('canvas').click({ position: { x: 900, y: 600 } })
  await page.mouse.click(img.x + 40, img.y + img.height + 150)
  await page.keyboard.type('Z')
  await expect(box.locator('p').last()).toHaveText('Z')
  await expect(box).toContainText('Text above.')
})
