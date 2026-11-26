import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import type { PrivacyStatus } from '../../src/shared/api'
import { reviewUi } from './review'

/** Asks for `feature` the way a settings section will (`askConsent`), through the e2e hook; the answer lands in `slateTest.consentResult`. */
async function ask(page: Page, feature: string, alternative?: string): Promise<void> {
  if ((await page.getByTestId('consent-dialog').count()) === 0) {
    await page.evaluate(({ f, alt }) => (window as unknown as { slateTest: { askConsent(f: string, alt?: string): void } }).slateTest.askConsent(f, alt), { f: feature, alt: alternative })
  }
  await expect(page.getByTestId('consent-dialog')).toBeVisible()
}

const answer = (page: Page) => page.evaluate(() => (window as unknown as { slateTest: { consentResult: boolean | string | null } }).slateTest.consentResult)
const status = (page: Page) => page.evaluate(() => window.slate.privacy.status()) as Promise<PrivacyStatus>

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('consent-dialog')).toHaveCount(0)
}

test('UI: consent dialog for automatic update checks', async ({ app, page }) => {
  await reviewUi(app, page, 'consent dialog updates', { open: (p) => ask(p, 'updates'), close: closeDialog })
})

test('UI: consent dialog for unencrypted sync, with Encrypt my notes first as the main action', async ({ app, page }) => {
  await reviewUi(app, page, 'consent dialog plaintext sync', { open: (p) => ask(p, 'plaintextSync', 'Encrypt my notes first'), close: closeDialog })
})

test('UI: consent dialog for the GitHub sign-in (the longest disclosure)', async ({ app, page }) => {
  await reviewUi(app, page, 'consent dialog github sign-in', { open: (p) => ask(p, 'githubSignIn'), close: closeDialog })
})

test('the dialog shows the disclosure and Allow records a user grant in main', async ({ page }) => {
  expect((await status(page)).allowed.updates).toBe(false)
  await ask(page, 'updates')
  const dialog = page.getByTestId('consent-dialog')
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Check for updates automatically')
  await expect(dialog.getByTestId('consent-endpoints')).toContainText('github.com')
  await expect(dialog.getByTestId('consent-endpoints')).toContainText('objects.githubusercontent.com')
  await expect(dialog.getByTestId('consent-data')).toContainText('Your IP address')
  await expect(dialog.getByTestId('consent-recipient')).toContainText('GitHub, Inc. (USA)')
  await expect(dialog.getByRole('link', { name: 'privacy notice' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Allow' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await answer(page)).toBe(true)
  const s = await status(page)
  expect(s.allowed.updates).toBe(true)
  expect(s.consents.updates?.source).toBe('user')
})

test('Not now and Escape record nothing; focus stays inside the dialog', async ({ page }) => {
  await ask(page, 'claudeTheme')
  const dialog = page.getByTestId('consent-dialog')
  await expect(dialog).toContainText('Anthropic')
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Shift+Tab')
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await closeDialog(page)
  expect(await answer(page)).toBe(false)
  await ask(page, 'claudeTheme')
  await dialog.getByRole('button', { name: 'Not now' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await answer(page)).toBe(false)
  expect((await status(page)).consents).toEqual({})
})

test('the alternative action closes the dialog without a grant and runs instead', async ({ page }) => {
  await ask(page, 'plaintextSync', 'Encrypt my notes first')
  const dialog = page.getByTestId('consent-dialog')
  await expect(dialog.getByTestId('consent-endpoints')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Encrypt my notes first' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await answer(page)).toBe('alternative')
  expect((await status(page)).allowed.plaintextSync).toBe(false)
})

test('a window cannot forge a consent through settings.set', async ({ page }) => {
  const forged = { updates: { grantedAt: 1, textVersion: 1, source: 'user' } }
  const after = await page.evaluate((consents) => window.slate.settings.set({ consents } as never), forged)
  expect(after.consents).toEqual({})
  expect((await status(page)).allowed.updates).toBe(false)
})
