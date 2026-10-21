import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchApp, MOD, test } from './fixtures'

const width = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!.width

async function drag(page: Page, testId: string, dx: number) {
  const box = (await page.getByTestId(testId).boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

test('the activity bar button hides and shows the library panel', async ({ page }) => {
  await expect(page.getByTestId('activity-bar')).toBeVisible()
  await expect(page.getByTestId('activity-library')).toHaveAttribute('aria-pressed', 'true')
  const before = await width(page, 'canvas')
  await page.getByTestId('activity-library').click()
  await expect(page.getByTestId('library-panel')).toHaveCount(0)
  await expect(page.getByTestId('activity-library')).toHaveAttribute('aria-pressed', 'false')
  expect(await width(page, 'canvas')).toBeGreaterThan(before + 200)
  await page.getByTestId('activity-library').click()
  await expect(page.getByTestId('library-panel')).toHaveCount(1)
})

test('Mod+\\ toggles the panel while typing without inserting a backslash', async ({ page }) => {
  await page.getByTestId('canvas').click({ position: { x: 100, y: 100 } })
  await expect(page.getByTestId('box-editor')).toBeFocused()
  await page.keyboard.type('hi')
  await page.keyboard.press(`${MOD}+\\`)
  await expect(page.getByTestId('library-panel')).toHaveCount(0)
  await expect(page.getByTestId('box')).toHaveText('hi')
  await page.keyboard.press(`${MOD}+\\`)
  await expect(page.getByTestId('library-panel')).toHaveCount(1)
})

test('splitters resize, clamp, reset and respond to the keyboard', async ({ page }) => {
  expect(await width(page, 'sections-column')).toBeCloseTo(260, 0)
  await drag(page, 'splitter-sections', 100)
  expect(Math.abs((await width(page, 'sections-column')) - 360)).toBeLessThanOrEqual(4)
  await drag(page, 'splitter-sections', -600)
  expect(await width(page, 'sections-column')).toBeCloseTo(140, 0)
  await page.getByTestId('splitter-sections').dblclick()
  expect(await width(page, 'sections-column')).toBeCloseTo(260, 0)

  await page.getByTestId('splitter-pages').focus()
  await page.keyboard.press('ArrowRight')
  expect(await width(page, 'pages-column')).toBeCloseTo(276, 0)
  await expect(page.getByTestId('splitter-pages')).toHaveAttribute('aria-valuenow', '276')
})

test('hidden panel and column widths survive a relaunch', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  await drag(first.page, 'splitter-sections', 60)
  await first.page.getByTestId('activity-library').click()
  await first.app.close()

  const second = await launchApp(userData)
  await expect(second.page.getByTestId('activity-bar')).toBeVisible()
  await expect(second.page.getByTestId('library-panel')).toHaveCount(0)
  await second.page.getByTestId('activity-library').click()
  expect(Math.abs((await width(second.page, 'sections-column')) - 320)).toBeLessThanOrEqual(4)
  await second.app.close()
})
