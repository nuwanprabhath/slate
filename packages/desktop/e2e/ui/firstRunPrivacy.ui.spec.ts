import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import type { PrivacyStatus } from '../../src/shared/api'
import { reviewUi } from './review'
import { stubInvoke } from './states'

const card = (page: Page) => page.getByTestId('first-run-privacy')
const show = (page: Page) => page.evaluate(() => (window as unknown as { slateTest: { showFirstRunPrivacy(): void } }).slateTest.showFirstRunPrivacy())
const status = (page: Page) => page.evaluate(() => window.slate.privacy.status()) as Promise<PrivacyStatus>
/** The card's answer is its own setting; the plugins' bag no longer holds it. */
const answered = (page: Page) => page.evaluate(() => window.slate.settings.get().then((s) => ({ seen: s.firstRunPrivacySeen, inPlugins: 'firstRunPrivacy' in s.plugins })))

/** What a legacy install's status reports: `updates` and `gitSync` carried over, not yet reviewed. */
const LEGACY: PrivacyStatus = {
  gdprStrictMode: true,
  consents: { updates: { grantedAt: 1, textVersion: 1, source: 'legacy' }, gitSync: { grantedAt: 1, textVersion: 1, source: 'legacy' } },
  allowed: { updates: true, gitSync: true, oneDriveSync: false, plaintextSync: false, microsoftSignIn: false, githubSignIn: false, claudeTheme: false },
  legacy: ['updates', 'gitSync'],
  profile: null,
}

test('a fresh profile never shows the card over other specs, but shows it when asked', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  await show(page)
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toContainText('Slate keeps your notes on this computer. Nothing is sent anywhere unless you turn it on.')
  await expect(card(page)).toContainText('Check for updates automatically (asks github.com; sends your IP address and Slate’s version)')
})

test('UI: first-run privacy card', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await reviewUi(app, page, 'first-run privacy card', {
    open: async (p) => {
      await show(p)
      await expect(card(p)).toBeVisible()
    },
  })
})

test('UI: privacy review card for features an existing install keeps', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await stubInvoke(app, 'privacy:status', LEGACY)
  await reviewUi(app, page, 'first-run privacy legacy card', {
    open: async (p) => {
      await show(p)
      await expect(p.getByTestId('first-run-legacy')).toBeVisible()
    },
  })
})

test('turning on updates asks for consent, records it, and the card does not return', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await show(page)
  await card(page).getByTestId('first-run-updates').click()
  const dialog = page.getByTestId('consent-dialog')
  await expect(dialog).toContainText('Check for updates automatically')
  await dialog.getByRole('button', { name: 'Allow' }).click()
  await expect(card(page)).toHaveCount(0)
  expect((await status(page)).allowed.updates).toBe(true)
  expect(await answered(page)).toEqual({ seen: true, inPlugins: false })
  await show(page)
  await expect(card(page)).toHaveCount(0)
})

test('declining the consent leaves the card; No thanks is remembered and grants nothing', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await show(page)
  await card(page).getByTestId('first-run-updates').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('consent-dialog')).toHaveCount(0)
  await expect(card(page)).toBeVisible()
  expect((await status(page)).consents).toEqual({})
  await card(page).getByTestId('first-run-dismiss').click()
  await expect(card(page)).toHaveCount(0)
  expect(await answered(page)).toEqual({ seen: true, inPlugins: false })
  expect((await status(page)).allowed.updates).toBe(false)
  await show(page)
  await expect(card(page)).toHaveCount(0)
})

test('Escape closes the card like No thanks', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await show(page)
  await card(page).getByTestId('first-run-dismiss').focus()
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
  expect(await answered(page)).toEqual({ seen: true, inPlugins: false })
})

test('the legacy card lists the features, Keep grants and Withdraw revokes', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  const calls: string[] = []
  await stubInvoke(app, 'privacy:status', LEGACY)
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { privacyCalls: string[] }
    g.privacyCalls = []
    for (const ch of ['privacy:grant', 'privacy:revoke']) {
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, (_e, f: string) => {
        g.privacyCalls.push(`${ch}:${f}`)
        return { gdprStrictMode: true, consents: {}, allowed: {}, legacy: [], profile: null }
      })
    }
  })
  await show(page)
  const legacy = page.getByTestId('first-run-legacy')
  await expect(legacy).toContainText('Check for updates automatically')
  await expect(legacy).toContainText('Sync your notes with a git repository')
  await legacy.getByTestId('first-run-legacy-updates').getByRole('button', { name: 'Keep' }).click()
  await expect(legacy).toHaveCount(0)
  calls.push(...(await app.evaluate(() => (globalThis as unknown as { privacyCalls: string[] }).privacyCalls)))
  expect(calls).toEqual(['privacy:grant:updates'])
})
