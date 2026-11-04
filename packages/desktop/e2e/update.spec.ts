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
    await expect(section.getByTestId('update-reason')).toContainText('Install and restart installs the update with apt')

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

test('Install and restart installs without a password when none is needed and says it is restarting', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb' })
  try {
    const banner = page.getByTestId('update-banner')
    await expect(banner).toContainText('Slate 9.9.9 is available')
    await page.getByTestId('update-install-restart').click()
    await expect(banner).toHaveAttribute('data-phase', 'restarting')
    await expect(banner).toContainText('Restarting into Slate 9.9.9')
    // Nothing else is offered once it is under way.
    await expect(banner.getByRole('button')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Install and restart asks for the password, refuses a wrong one, then installs with the right one', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb-sudo' })
  try {
    const banner = page.getByTestId('update-banner')
    await expect(banner).toContainText('Slate 9.9.9 is available')
    await page.getByTestId('update-install-restart').click()
    await expect(banner).toHaveAttribute('data-phase', 'needs-password')
    await expect(banner).toContainText('Slate 9.9.9 needs your password to install')
    const field = page.getByTestId('update-password')
    await expect(field).toBeFocused()
    await expect(page.getByTestId('update-password-note')).toContainText('never saved')

    await field.fill('not it')
    await page.getByTestId('update-password-submit').click()
    await expect(banner).toContainText('Could not install Slate 9.9.9: That password was not accepted.')
    // The typed text left the field with the submit, so a refused password comes back to an empty one.
    await expect(field).toHaveValue('')
    await expect(field).toBeFocused()

    await field.fill('sesame')
    await field.press('Enter')
    await expect(banner).toHaveAttribute('data-phase', 'restarting')
    // The password is in no text the page shows.
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('sesame')
  } finally {
    await app.close()
  }
})

test('Cancel on the password form keeps the download and offers Install and restart again', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb-sudo' })
  try {
    const banner = page.getByTestId('update-banner')
    await page.getByTestId('update-install-restart').click()
    await expect(banner).toHaveAttribute('data-phase', 'needs-password')
    await page.getByTestId('update-password-cancel').click()
    await expect(banner).toHaveAttribute('data-phase', 'downloaded')
    await expect(banner).toContainText('Slate 9.9.9 is downloaded')
    await expect(page.getByTestId('update-install-restart')).toHaveText('Install and restart')
  } finally {
    await app.close()
  }
})

test('a failed install says why and offers Try again, keeping the download for the install command', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb-installfail' })
  try {
    const banner = page.getByTestId('update-banner')
    await page.getByTestId('update-install-restart').click()
    await expect(banner).toContainText('Could not install Slate 9.9.9: apt-get exited with 100.')
    await expect(page.getByTestId('update-install-restart')).toHaveText('Try again')
    await expect(page.getByTestId('update-copy-command')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a mac build offers Install and restart beside Download', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'dmg' })
  try {
    await expect(page.getByTestId('update-banner')).toContainText('Slate 9.9.9 is available')
    await expect(page.getByTestId('update-install-restart')).toBeVisible()
    await expect(page.getByTestId('update-download')).toHaveText('Download')
    await page.getByTestId('update-install-restart').click()
    await expect(page.getByTestId('update-banner')).toHaveAttribute('data-phase', 'restarting')
  } finally {
    await app.close()
  }
})

test('an AppImage offers the same Install and restart, which downloads and restarts with no password', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'auto' })
  try {
    const banner = page.getByTestId('update-banner')
    await expect(banner).toContainText('Slate 9.9.9 is available')
    await expect(page.getByTestId('update-download')).toHaveCount(0)
    await page.getByTestId('update-install-restart').click()
    await expect(banner).toHaveAttribute('data-phase', 'restarting')
    await expect(banner).toContainText('Restarting into Slate 9.9.9')
    await expect(page.getByTestId('update-password')).toHaveCount(0)
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
