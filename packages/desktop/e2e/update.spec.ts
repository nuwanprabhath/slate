import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'

const readSecurityLog = (userData: string): string => {
  try {
    return readFileSync(join(userData, 'security-log', 'slate.log'), 'utf8')
  } catch {
    return ''
  }
}

test('the update banner offers the fake release, copies the install command and dismisses', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb' })
  try {
    const banner = page.getByTestId('update-banner')
    await expect(banner).toContainText('Slate 9.9.9 is available')
    await banner.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(page.getByTestId('update-progress')).toBeVisible()
    await expect(banner).toContainText('Slate 9.9.9 is downloaded')

    await page.getByTestId('update-copy-command').click()
    await expect(page.getByTestId('update-copy-command')).toHaveText('Copied')
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).toMatch(/^sudo apt install '.*Slate-9\.9\.9-linux-(amd|arm)64\.deb'$/)

    await page.getByTestId('update-dismiss').click()
    await expect(banner).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('skipping hides the banner; the updates section says so and Stop skipping brings it back', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb' })
  try {
    const banner = page.getByTestId('update-banner')
    await expect(banner).toContainText('Slate 9.9.9 is available')
    await banner.getByRole('button', { name: 'Skip this version' }).click()
    await expect(banner).toHaveCount(0)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:command', { cmd: 'show-settings', section: 'updates' }))
    const section = page.getByTestId('updates-section')
    await expect(section.getByTestId('update-skipped')).toContainText('Skipping 9.9.9')
    await expect(section.getByTestId('update-version')).toHaveText('Version 0.1.0')
    await expect(section.getByTestId('update-reason')).toContainText('sudo apt install')

    await section.getByTestId('update-check-now').click()
    await expect(section.getByTestId('update-check-result')).toHaveText('Slate 9.9.9 is available (skipped).')

    await section.getByTestId('update-unskip').click()
    await expect(section.getByTestId('update-skipped')).toHaveCount(0)
    await expect(banner).toContainText('Slate 9.9.9 is available')
  } finally {
    await app.close()
  }
})

test('the section switches automatic checks and the interval through the settings', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb' })
  try {
    await page.getByTestId('update-settings').click()
    const section = page.getByTestId('updates-section')
    await section.getByTestId('setting-update-interval').selectOption('12')
    await expect.poll(() => page.evaluate(() => window.slate.settings.get().then((s) => s.updateCheckIntervalHours))).toBe(12)
    await section.getByTestId('setting-update-automatic').uncheck()
    await expect(section.getByTestId('setting-update-interval')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.slate.settings.get().then((s) => s.updateAutomaticChecks))).toBe(false)
  } finally {
    await app.close()
  }
})

test('without SLATE_FAKE_UPDATE an e2e run never shows the banner', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.waitForTimeout(1000)
  await expect(page.getByTestId('update-banner')).toHaveCount(0)
})

test('T-UPD-01: a feed signed by a key that is not pinned is never offered', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb-badsig' })
  try {
    await expect(page.getByTestId('canvas')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:command', { cmd: 'show-settings', section: 'updates' }))
    const section = page.getByTestId('updates-section')
    await section.getByTestId('update-check-now').click()
    await expect(section.getByTestId('update-check-result')).toContainText(/Could not check: .*is not pinned/)
    await expect(page.getByTestId('update-banner')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('T-PQ-A2-06: the fake feed with a hybrid signature is offered; with the ML-DSA half stripped it is not, and the log says so', async () => {
  const good = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb' })
  try {
    await expect(good.page.getByTestId('update-banner')).toContainText('Slate 9.9.9 is available')
  } finally {
    await good.app.close()
  }

  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, { SLATE_FAKE_UPDATE: 'deb-nomldsa' })
  try {
    await expect(page.getByTestId('canvas')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:command', { cmd: 'show-settings', section: 'updates' }))
    const section = page.getByTestId('updates-section')
    await section.getByTestId('update-check-now').click()
    await expect(section.getByTestId('update-check-result')).toContainText(/Could not check: .*ed25519 and mldsa65/)
    await expect(page.getByTestId('update-banner')).toHaveCount(0)
    // The security log is always on (securityEvents.ts), so a default install records the refusal.
    await expect.poll(() => readSecurityLog(userData)).toContain('update.signature.failed')
  } finally {
    await app.close()
  }
})
