import type { Page } from '@playwright/test'
import { expect, launchApp, MOD, test } from './fixtures'

const bar = (page: Page) => page.getByTestId('title-bar')
const background = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => getComputedStyle(el).backgroundColor)
const toolbarToken = (page: Page) =>
  page.evaluate(() => {
    // Resolved through an element, so it compares in the same rgb() form as the bar.
    const probe = document.createElement('div')
    probe.style.background = 'var(--toolbar-bg)'
    document.body.append(probe)
    const colour = getComputedStyle(probe).backgroundColor
    probe.remove()
    return colour
  })

async function chooseTheme(page: Page, id: string) {
  await page.keyboard.press(`${MOD}+,`)
  await page.locator('.settings-nav-item', { hasText: 'Appearance' }).click()
  await page.locator(`[data-testid="theme-card"][data-theme-id="${id}"]`).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toBeHidden()
}

test('the title bar sits at the top, 32–38 px tall, with the app below it', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  const box = (await bar(page).boundingBox())!
  expect(box.y).toBe(0)
  expect(box.height).toBeGreaterThanOrEqual(32)
  expect(box.height).toBeLessThanOrEqual(38)
  const activity = (await page.locator('.app').boundingBox())!
  expect(activity.y).toBe(box.y + box.height)
})

test('the bar takes the toolbar colour and follows the theme', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  const dark = await background(page, 'title-bar')
  expect(dark).toBe(await toolbarToken(page))
  await chooseTheme(page, 'builtin:paper')
  await expect.poll(() => background(page, 'title-bar')).not.toBe(dark)
  expect(await background(page, 'title-bar')).toBe(await toolbarToken(page))
})

test('the bar shows the current page and notebook', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  const pageTitle = await page.locator('.page-row.selected .label').innerText()
  await expect(page.getByTestId('title-bar-title')).toContainText(pageTitle)
})

test('on Linux and Windows the in-app menu bar opens File', async ({ page }) => {
  test.skip(process.platform === 'darwin', 'macOS keeps its system menu bar')
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.getByTestId('menu-bar-file').click()
  await expect(page.getByTestId('menu-bar-dropdown')).toContainText('Import from OneNote…')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('menu-bar-dropdown')).toBeHidden()
})

test('with systemTitleBar on, after a relaunch no custom bar is drawn', async ({ userData }) => {
  const first = await launchApp(userData)
  await expect(first.page.getByTestId('canvas')).toBeVisible()
  await expect(bar(first.page)).toBeVisible()
  await first.page.evaluate(() => window.slate.settings.set({ systemTitleBar: true }))
  await first.app.close()
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('canvas')).toBeVisible()
  await expect(bar(second.page)).toHaveCount(0)
  expect((await second.page.locator('.app').boundingBox())!.y).toBe(0)
  await second.app.close()
})
