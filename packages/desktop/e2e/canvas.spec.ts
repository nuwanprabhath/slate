import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createBoxAt,expect, launchApp, MOD, test } from './fixtures'

async function newBox(page: Page, x: number, y: number) {
  await createBoxAt(page, x, y)
  // Wait for the NEW (empty) box to own focus: DOM order is by random box id, so .last() may be an old box.
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
}

test('click on the canvas creates a box you can type in', async ({ page }) => {
  await newBox(page, 200, 150)
  await page.keyboard.type('hello slate')
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box-editor')).toHaveText('hello slate')
})

test('an empty box disappears when it loses focus', async ({ page }) => {
  await newBox(page, 100, 100)
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  await expect(page.getByTestId('box')).toHaveCount(0)
})

test('boxes can be dragged and resized', async ({ page }) => {
  await newBox(page, 100, 100)
  await page.keyboard.type('drag me')
  const box = page.getByTestId('box')
  const before = await box.boundingBox()
  await box.hover()
  const handle = await page.getByTestId('box-handle').boundingBox()
  await page.mouse.move(handle!.x + 20, handle!.y + 5)
  await page.mouse.down()
  await page.mouse.move(handle!.x + 120, handle!.y + 65, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await box.boundingBox())!.x).toBeCloseTo(before!.x + 100, -1)
  const resize = await page.getByTestId('box-resize').boundingBox()
  await page.mouse.move(resize!.x + 4, resize!.y + 10)
  await page.mouse.down()
  await page.mouse.move(resize!.x + 104, resize!.y + 10, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await box.boundingBox())!.width).toBeCloseTo(before!.width + 100, -1)
})

test('undo reverts typing', async ({ page }) => {
  await newBox(page, 100, 100)
  await page.keyboard.type('keep')
  await page.waitForTimeout(700) // let the undo step close
  await page.keyboard.type(' drop')
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('box-editor')).toHaveText('keep')
})

test('content persists across restarts', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  await newBox(first.page, 150, 120)
  await first.page.keyboard.type('survives restart')
  await first.page.waitForTimeout(300)
  await first.app.close()
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('box')).toHaveCount(1)
  await expect(second.page.getByTestId('box').first()).toContainText('survives restart')
  await second.app.close()
})
