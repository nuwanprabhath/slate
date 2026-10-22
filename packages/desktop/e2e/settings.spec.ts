import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchApp, MOD, test } from './fixtures'

async function openWithShortcut(page: Page) {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.keyboard.press(`${MOD}+,`)
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
}

test('Cmd/Ctrl+, opens Settings with Autocorrect, Sync and General; Escape closes it', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await openWithShortcut(page)
  await expect(page.locator('.settings-nav-item')).toHaveText(['Autocorrect', 'Sync', 'General'])
  await expect(page.getByTestId('settings-heading')).toHaveText('Autocorrect')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
})

test('the activity bar gear opens Settings, and the close button closes it', async ({ page }) => {
  await page.getByTestId('activity-settings').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
})

test('typing in the search filters the sections', async ({ page }) => {
  await page.getByTestId('activity-settings').click()
  await page.getByTestId('settings-search').fill('git')
  await expect(page.locator('.settings-nav-item')).toHaveText(['Sync'])
  await expect(page.getByTestId('settings-heading')).toHaveText('Sync')
  await page.getByTestId('settings-search').fill('')
  await expect(page.locator('.settings-nav-item')).toHaveCount(3)
})

test('show-settings with a section opens that section', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', { cmd: 'show-settings', section: 'sync' }))
  await expect(page.getByTestId('settings-heading')).toHaveText('Sync')
  await expect(page.getByTestId('sync-settings')).toBeVisible()
})

test('a change in the dialog updates the View menu checkbox', async ({ app, page }) => {
  await page.getByTestId('activity-settings').click()
  await page.getByTestId('setting-markdown-shortcuts').check()
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('markdown-shortcuts')!.checked)).toBe(true)
})

test('turning auto bullets off persists across a restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  await openWithShortcut(first.page)
  await expect(first.page.getByTestId('setting-auto-bullets')).toBeChecked()
  await first.page.getByTestId('setting-auto-bullets').uncheck()
  await expect.poll(() => first.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('auto-bullets')!.checked)).toBe(false)
  await first.app.close()
  const second = await launchApp(userData)
  await openWithShortcut(second.page)
  await expect(second.page.getByTestId('setting-auto-bullets')).not.toBeChecked()
  await second.app.close()
})
