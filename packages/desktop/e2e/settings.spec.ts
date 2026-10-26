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

test('Cmd/Ctrl+, opens Settings with Autocorrect, Appearance, Sync, General, Security, Updates and Diagnostics; Escape closes it', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await openWithShortcut(page)
  await expect(page.locator('.settings-nav-item')).toHaveText(['Autocorrect', 'Appearance', 'Sync', 'General', 'Security', 'Updates', 'Diagnostics'])
  await expect(page.getByTestId('settings-heading')).toHaveText('Autocorrect')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
})

test('Settings → Security shows the cryptographic module, its CMVP certificate and approved mode (audit C2, F-FIPS-08)', async ({ page }) => {
  await openWithShortcut(page)
  await page.locator('.settings-nav-item', { hasText: 'Security' }).click()
  const group = page.getByTestId('security-module')
  await expect(group).toBeVisible()
  await expect(group.getByTestId('security-module-validation')).toHaveText('ValidationFIPS 140-3, CMVP certificate #4985')
  const moduleRow = group.getByTestId('security-module-module')
  await expect(moduleRow).toHaveText(/^Module(OpenSSL FIPS Provider 3\.1\.2|Not available)$/)
  // A checkout with the addon and provider built (npm run -w @slate/native build) runs in approved mode.
  if ((await moduleRow.textContent())?.includes('3.1.2')) {
    await expect(group.getByTestId('security-module-approved-mode')).toHaveText('Approved modeOn')
    await expect(group.getByTestId('security-module-self-test-at-launch')).toHaveText(/^Self-test at launchPassed in \d+ ms$/)
    await expect(group.getByTestId('security-module-library')).toHaveText(/^LibraryOpenSSL 3\.5\.\d+/)
  }
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
  await expect(page.locator('.settings-nav-item')).toHaveCount(7)
})

test('show-settings with a section opens that section', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:command', { cmd: 'show-settings', section: 'sync' }))
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
