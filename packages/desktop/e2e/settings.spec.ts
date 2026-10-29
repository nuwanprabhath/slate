import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createBoxAt, expect, launchApp, MOD, test, unlockWith } from './fixtures'
import { stubInvoke } from './ui/states'

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

test("POAM-16: without Chromium's sandbox the lock screen says so, Settings → Security warns until dismissed, and the security log records it", async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const password = 'e2e sandbox password'
  const { app, page: lock } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: password }, ['--no-sandbox'])
  await expect(lock.getByTestId('lock-screen')).toBeVisible()
  await expect(lock.getByTestId('lock-sandbox-note')).toContainText("without Chromium's sandbox")
  const page = await unlockWith(app, lock, password)
  await openWithShortcut(page)
  await page.locator('.settings-nav-item', { hasText: 'Security' }).click()
  const notice = page.getByTestId('security-sandbox-notice')
  await expect(notice).toContainText('other programs running as you can read their memory')
  await expect(notice).toContainText('.deb')
  await page.getByTestId('security-sandbox-dismiss').click()
  await expect(notice).toHaveCount(0)
  await page.keyboard.press('Escape')
  await openWithShortcut(page)
  await page.locator('.settings-nav-item', { hasText: 'Security' }).click()
  await expect(page.getByTestId('security-module')).toBeVisible()
  await expect(page.getByTestId('security-sandbox-notice')).toHaveCount(0)
  await app.close()
  const dir = join(userData, 'security-log')
  const log = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('')
  expect(log).toContain('app.renderer.unsandboxed {"reason":"no-sandbox-switch"}')
})

test('POAM-16: a sandboxed run shows no sandbox notice', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page: lock } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: 'e2e sandbox password' })
  await expect(lock.getByTestId('lock-screen')).toBeVisible()
  await expect(lock.getByTestId('lock-quick')).toBeAttached()
  await expect(lock.getByTestId('lock-sandbox-note')).toHaveCount(0)
  await app.close()
})

const SSH_GIT = { syncProvider: 'git', git: { remoteUrl: 'git@example.invalid:me/notes.git', branch: 'main', auth: 'system' } } as const

async function openSync(page: Page) {
  await openWithShortcut(page)
  await page.getByTestId('settings-nav-sync').click()
  await expect(page.getByTestId('sync-settings')).toBeVisible()
}

test('T-PQ-D2-01: with a git SSH remote "Require post-quantum key exchange" turns on, persists across relaunch; with OneDrive it is disabled and says why', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  let launched = await launchApp(userData)
  await expect(launched.page.getByTestId('canvas')).toBeVisible()
  await launched.page.evaluate((patch) => window.slate.settings.set(patch), SSH_GIT)
  // The real probe would dial the example host; main answers the check with nothing observed yet.
  await stubInvoke(launched.app, 'sync:check-transport', [])
  await openSync(launched.page)
  const toggle = launched.page.getByTestId('sync-require-pq-toggle')
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect.poll(() => launched.page.evaluate(async () => (await window.slate.settings.get()).syncRequirePq)).toBe(true)
  await launched.app.close()

  launched = await launchApp(userData)
  await expect(launched.page.getByTestId('canvas')).toBeVisible()
  await openSync(launched.page)
  await expect(launched.page.getByTestId('sync-require-pq-toggle')).toBeChecked()

  await launched.page.getByTestId('sync-provider-onedrive').click()
  await expect(launched.page.getByTestId('sync-require-pq-toggle')).toBeDisabled()
  await expect(launched.page.getByTestId('sync-require-pq-help')).toHaveText('Microsoft OneDrive does not offer post-quantum key exchange yet')
  await launched.page.getByTestId('sync-provider-git').click()
  await launched.page.getByTestId('git-remote-url').fill('https://example.invalid/me/notes.git')
  await expect(launched.page.getByTestId('sync-require-pq-toggle')).toBeDisabled()
  await expect(launched.page.getByTestId('sync-require-pq-help')).toHaveText('Use an SSH remote for post-quantum key exchange')
  await launched.app.close()
})

test('T-PQ-D2-02: the vault format banner never covers the editor or takes focus', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await createBoxAt(page, 200, 200)
  await page.keyboard.type('typing continues')
  const canvasTop = (await page.getByTestId('canvas').boundingBox())!.y
  await stubInvoke(app, 'vault:pq-readiness', { atRest: 'symmetric-256', vault: { kind: 'header', version: 2, upgrade: 'running', blockingDevices: [] }, transports: [], updateSignature: 'ed25519', plaintextSync: false, requirePq: false })
  const banner = page.getByTestId('vault-format-banner')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  // It sits above the notes (they moved down to make room) and does not overlap them.
  const bannerBox = (await banner.boundingBox())!
  const canvasBox = (await page.getByTestId('canvas').boundingBox())!
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(canvasBox.y + 0.5)
  expect(canvasBox.y).toBeGreaterThanOrEqual(canvasTop)
  // Focus stayed where the person was typing, and typing still lands there.
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="canvas"]') !== null)).toBe(true)
  expect(await banner.evaluate((el) => el.contains(document.activeElement))).toBe(false)
  await page.keyboard.type(' still')
  await expect(page.getByTestId('canvas')).toContainText('typing continues still')
  // When the update finishes the line becomes "updated", once.
  await stubInvoke(app, 'vault:pq-readiness', { atRest: 'symmetric-256', vault: { kind: 'header', version: 3, upgrade: 'done', blockingDevices: [] }, transports: [], updateSignature: 'ed25519', plaintextSync: false, requirePq: false })
  await expect(banner).toContainText('Vault format updated', { timeout: 10_000 })
  expect(await banner.evaluate((el) => el.contains(document.activeElement))).toBe(false)
  await app.close()
})
