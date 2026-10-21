import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchApp, test } from './fixtures'

async function newBox(page: Page, x: number, y: number, text: string) {
  await page.getByTestId('canvas').click({ position: { x, y } })
  // Wait for the NEW (empty) box to own focus: DOM order is by random box id, so .last() may be an old box.
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type(text)
}

test('a growing box pushes the box below it down', async ({ page }) => {
  await newBox(page, 40, 40, 'top box')
  await newBox(page, 60, 140, 'below')
  const top = page.getByTestId('box').filter({ hasText: 'top box' })
  const below = page.getByTestId('box').filter({ hasText: 'below' })
  const before = (await below.boundingBox())!.y
  await top.getByTestId('box-editor').click()
  await page.keyboard.press('End')
  for (let i = 0; i < 8; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('more')
  await expect.poll(async () => (await below.boundingBox())!.y).toBeGreaterThan(before + 60)
  const topBox = (await top.boundingBox())!
  expect((await below.boundingBox())!.y).toBeGreaterThanOrEqual(topBox.y + topBox.height)
})

test('a box beside the growing box does not move', async ({ page }) => {
  await newBox(page, 40, 40, 'left')
  await newBox(page, 700, 100, 'right side')
  const right = page.getByTestId('box').filter({ hasText: 'right side' })
  const before = (await right.boundingBox())!.y
  await page.getByTestId('box').filter({ hasText: 'left' }).getByTestId('box-editor').click()
  for (let i = 0; i < 6; i++) await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  expect((await right.boundingBox())!.y).toBe(before)
})

test('the private flag toggles, is visible, and persists', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  await newBox(first.page, 100, 100, 'secret token')
  const box = first.page.getByTestId('box')
  await box.hover()
  await first.page.getByTestId('box-lock').click()
  await expect(box).toHaveClass(/is-private/)
  await expect(first.page.getByTestId('box-lock')).toHaveAttribute('aria-pressed', 'true')
  await first.page.waitForTimeout(300)
  await first.app.close()
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('box')).toHaveClass(/is-private/)
  await second.app.close()
})
