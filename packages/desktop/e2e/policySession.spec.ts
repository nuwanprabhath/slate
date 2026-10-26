import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp, test, windowAfterUnlock } from './fixtures'

// Review C10 HIGH: main enforces the vault's profile on every path that opens a vault, not only the lock screen's.
const PASSWORD = 'e2e policy password 15+'
const FIPS = { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD, SLATE_TEST_PROFILE: 'fips-140-3' }

/** Stores `lockOnSleep: false` and "Never" idle, emits a system suspend, and expects the lock screen (AC-11, AC-12). */
async function suspendLocksDespiteSettings(app: ElectronApplication, notes: Page, userData: string): Promise<void> {
  await notes.evaluate(() => window.slate.settings.set({ lockOnSleep: false, lockOnScreenLock: false, idleMinutes: 0 }))
  // main re-reads the lock screen's file after writing it; wait until it holds the stored values.
  await expect.poll(() => (JSON.parse(readFileSync(join(userData, 'preunlock.json'), 'utf8')) as { lockOnSleep: boolean }).lockOnSleep).toBe(false)
  await notes.waitForTimeout(500)
  await expect(notes.getByTestId('lock-screen')).toHaveCount(0)
  expect(await notes.evaluate(() => window.slate.vault.status().then((v) => v.state))).toBe('unlocked')
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('suspend')
  })
  await expect
    .poll(async () => {
      for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return true
      return false
    }, { timeout: 15_000 })
    .toBe(true)
}

test('T-POL-03: a fips-140-3 vault opened by the lock screen locks on suspend with the settings off', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, FIPS)
  try {
    await page.getByTestId('lock-secret').fill(PASSWORD)
    await page.getByTestId('lock-unlock').click()
    await suspendLocksDespiteSettings(app, await windowAfterUnlock(app, page), userData)
  } finally {
    await app.close()
  }
})

test('two unlocks at once: the loser gets an UnlockResult, not an IPC rejection, and a wrong pair keeps the vault shut', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, FIPS)
  try {
    await expect(page.getByTestId('lock-screen')).toBeVisible()
    const outcomes = await page.evaluate(async () => {
      const bytes = (s: string) => new TextEncoder().encode(s) as never
      const settled = await Promise.allSettled([window.slate.vault.unlock(bytes('wrong one wrong one')), window.slate.vault.unlock(bytes('wrong two wrong two'))])
      return settled.map((r) => r.status)
    })
    expect(outcomes).toEqual(['fulfilled', 'fulfilled'])
    expect(await page.evaluate(() => window.slate.vault.status().then((v) => v.state))).toBe('locked')
  } finally {
    await app.close()
  }
})

test('the security log records unlock, failure and lock through index.ts with the diagnostic log off, and never a secret (C10 criterion 2)', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, FIPS)
  try {
    await page.getByTestId('lock-secret').fill('CANARY-wrong-5e1d77aa horse staple')
    await page.getByTestId('lock-unlock').click()
    await expect(page.getByTestId('lock-error')).toHaveText(/didn.t work/)
    await expect(async () => {
      await page.getByTestId('lock-secret').fill(PASSWORD)
      await expect(page.getByTestId('lock-unlock')).toBeEnabled({ timeout: 500 })
    }).toPass({ timeout: 10_000 })
    await page.getByTestId('lock-unlock').click()
    const notes = await windowAfterUnlock(app, page)
    await notes.evaluate(() => window.slate.vault.lock())
    await expect.poll(async () => {
      for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return true
      return false
    }).toBe(true)
  } finally {
    await app.close()
  }
  const text = readFileSync(join(userData, 'security-log', 'slate.log'), 'utf8')
  for (const event of ['vault.unlock.failed', 'vault.unlock.succeeded', 'vault.locked']) expect(text, event).toContain(event)
  expect(text).toContain('"trigger":"manual"')
  for (const canary of ['CANARY', PASSWORD, 'horse staple']) expect(text, canary).not.toContain(canary)
  expect(existsSync(join(userData, 'logs', 'slate.log'))).toBe(false)
})

test('T-POL-03: a fips-140-3 vault made by the wizard honours the same policy (no lock-screen unlock happened)', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, { SLATE_TEST_WEAK_KDF: '1' })
  try {
    await expect(page.getByTestId('canvas')).toBeVisible()
    await page.getByTestId('activity-settings').click()
    await page.locator('.settings-nav-item', { hasText: 'Security' }).click()
    await page.getByTestId('security-encrypt').click()
    const wizard = page.getByTestId('encrypt-wizard')
    await expect(wizard).toContainText('your notes are gone')
    await page.getByTestId('wizard-next').click()
    await page.getByTestId('wizard-profile-fips').check()
    await page.getByTestId('wizard-password').fill(PASSWORD)
    await page.getByTestId('wizard-password-again').fill(PASSWORD)
    await expect(page.getByTestId('wizard-next')).toBeEnabled()
    await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('recovery-key').locator('span')).toHaveCount(14)
    const recoveryKey = (await page.getByTestId('recovery-key').locator('span').allTextContents()).join('-')
    await page.getByTestId('wizard-next').click()
    await page.getByTestId('recovery-confirm-input').fill(recoveryKey.toLowerCase())
    await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('encrypt-wizard')).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByTestId('canvas')).toBeVisible()
    await suspendLocksDespiteSettings(app, page, userData)
  } finally {
    await app.close()
  }
})
