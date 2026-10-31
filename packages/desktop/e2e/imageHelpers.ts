import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { boxWithText } from './canvasHelpers'
import { expect, MOD } from './fixtures'

/** A box of text around a pasted 240x120 picture, the caret on the line below it. */
export async function boxWithImage(app: ElectronApplication, page: Page): Promise<Locator> {
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
  await expect.poll(() => box.locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(240)
  await page.keyboard.type('Text below the picture')
  return box
}
