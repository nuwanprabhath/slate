import type { Page } from '@playwright/test'
import { expect, MOD, test } from '../fixtures'
import type { PrivacyStatus } from '../../src/shared/api'
import { reviewUi } from './review'
import { stubInvoke, stubInvokeError } from './states'

async function openPrivacy(p: Page): Promise<void> {
  if (!(await p.getByTestId('settings-dialog').isVisible())) await p.keyboard.press(`${MOD}+,`)
  await p.getByTestId('settings-nav-privacy').click()
  await expect(p.getByTestId('privacy-section')).toBeVisible()
}

const close = (p: Page) => p.keyboard.press('Escape')
const scroll = '[data-testid="settings-body"]'

test('UI: Privacy with two grants, one kept from before strict mode', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => window.slate.privacy.grant('githubSignIn'))
  const s = await page.evaluate(() => window.slate.privacy.status())
  const withLegacy: PrivacyStatus = { ...s, consents: { ...s.consents, updates: { grantedAt: 1, textVersion: 1, source: 'legacy' } }, legacy: ['updates'] }
  await stubInvoke(app, 'privacy:status', withLegacy)
  await reviewUi(app, page, 'privacy grants', { scroll, close, open: async (p) => {
    await openPrivacy(p)
    await expect(p.getByTestId('privacy-consent-updates')).toContainText('Kept from before strict mode')
  } })
})

test('UI: Privacy strict mode off confirmation', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await reviewUi(app, page, 'privacy strict off', { scroll, close, open: async (p) => {
    await openPrivacy(p)
    await p.getByTestId('privacy-strict').uncheck()
    await expect(p.getByTestId('privacy-strict-off-list')).toBeVisible()
  } })
})

test('UI: Privacy security log shown, and Clear disabled under fips-140-3', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  const s = await page.evaluate(() => window.slate.privacy.status())
  await stubInvoke(app, 'privacy:status', { ...s, profile: 'fips-140-3' })
  const line = '2026-11-26T10:30:00.000Z info security unlock {"method":"password","outcome":"ok"}'
  await stubInvoke(app, 'privacy:security-log-read', Array.from({ length: 40 }, () => line).join('\n'))
  await reviewUi(app, page, 'privacy security log fips', { scroll, close, open: async (p) => {
    await openPrivacy(p)
    await expect(p.getByTestId('privacy-log-clear')).toBeDisabled()
    await expect(p.getByTestId('privacy-log-fips')).toBeVisible()
    await p.getByTestId('privacy-log-view').click()
    await expect(p.getByTestId('privacy-log-text')).toBeVisible()
  } })
})

test('UI: Privacy erase all, typed confirmation with sync on (unencrypted git remote)', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => window.slate.settings.set({ syncProvider: 'git', git: { remoteUrl: 'git@github.com:someone-with-a-long-name/my-slate-notes-repository.git', branch: 'main', auth: 'system' } }))
  await reviewUi(app, page, 'privacy erase all sync on', { scroll, close, open: async (p) => {
    await openPrivacy(p)
    await expect(p.getByTestId('privacy-replace-remote')).toBeDisabled()
    await expect(p.getByTestId('privacy-replace-remote-help')).toContainText('coming in the next release')
    await p.getByTestId('privacy-erase-all').click()
    await expect(p.getByTestId('privacy-all-remote')).toBeVisible()
    await p.getByTestId('privacy-all-typed').fill('ERA')
  } })
})

test('UI: Privacy purge confirmation and an export result', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await stubInvoke(app, 'privacy:export', { folder: '/Users/someone-with-a-long-name/Documents/Slate export 2026-11-26T10-30-00Z', pages: 128, images: 42, bytes: 1234567 })
  await reviewUi(app, page, 'privacy export and purge', { scroll, close, open: async (p) => {
    await openPrivacy(p)
    await p.getByTestId('privacy-export').click()
    await expect(p.getByTestId('privacy-data-note')).toContainText('Exported 128 pages')
    await p.getByTestId('privacy-purge').click()
    await expect(p.getByTestId('privacy-purge-confirm')).toBeVisible()
  } })
})

test('UI: Privacy erase edit history, offered for a page never synced, then done', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => window.slate.settings.set({ syncProvider: null }))
  // Something stored to erase: a page never edited has no history yet.
  await page.evaluate(() =>
    (window as unknown as { slateTest: { addBox(x: number, y: number, blocks: unknown[]): string } }).slateTest.addBox(40, 40, [{ type: 'paragraph', content: [{ type: 'text', text: 'Words to keep' }] }]),
  )
  await reviewUi(app, page, 'privacy erase history done', { scroll, close, open: async (p) => {
    await openPrivacy(p)
    await expect(p.getByTestId('privacy-erase')).toContainText('Only for a page that has never been synced')
    await p.getByTestId('privacy-erase-history').click()
    await expect(p.getByTestId('privacy-history-confirm')).toBeVisible()
    await p.getByTestId('privacy-history-confirm-yes').click()
    await expect(p.getByTestId('privacy-erase-note')).toContainText('edit history is erased')
  } })
})

test('UI: Privacy erase edit history refused for a page that was synced', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => window.slate.settings.set({ syncProvider: null }))
  await stubInvokeError(app, 'privacy:erase-history', 'This page has been synced, so another device may have it. Its edit history can only be erased while it exists on this computer alone.')
  await reviewUi(app, page, 'privacy erase history synced', { scroll, close, open: async (p) => {
    await openPrivacy(p)
    await p.getByTestId('privacy-erase-history').click()
    await p.getByTestId('privacy-history-confirm-yes').click()
    await expect(p.getByTestId('privacy-erase-note')).toContainText('another device may have it')
  } })
})
