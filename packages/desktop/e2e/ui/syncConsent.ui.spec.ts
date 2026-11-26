import type { Page } from '@playwright/test'
import { expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'
import { stubInvoke } from './states'

/** GDPR-03, -06, -11: Settings → Sync in each privacy state a person reaches. */

const GIT = { syncProvider: 'git', git: { remoteUrl: 'git@github.com:someone-with-a-long-name/my-slate-notes-repository.git', branch: 'main', auth: 'system' } } as const

async function openSync(p: Page): Promise<void> {
  if (!(await p.getByTestId('settings-dialog').isVisible())) await p.keyboard.press(`${MOD}+,`)
  await p.getByTestId('settings-nav-sync').click()
  await expect(p.getByTestId('sync-settings')).toBeVisible()
}

async function closeAll(p: Page): Promise<void> {
  for (let i = 0; i < 3 && (await p.locator('[data-testid="consent-dialog"], [data-testid="settings-dialog"]').count()) > 0; i++) await p.keyboard.press('Escape')
  await expect(p.getByTestId('consent-dialog')).toHaveCount(0)
}

/** Picks git with a remote and presses Save & sync, which opens the first consent step. */
async function saveGit(p: Page): Promise<void> {
  await openSync(p)
  await p.getByTestId('sync-provider-git').check()
  await p.getByTestId('git-remote-url').fill('file:///tmp/never-contacted.git')
  await p.getByTestId('sync-settings-save').click()
  await expect(p.getByTestId('consent-dialog')).toBeVisible()
}

test('UI: the gitSync consent step over Sync settings', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await reviewUi(app, page, 'sync consent git', { open: saveGit, close: closeAll })
})

test('UI: the unencrypted sync step, with Encrypt my notes first as the main action', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => window.slate.privacy.grant('gitSync'))
  await reviewUi(app, page, 'sync consent plaintext', {
    open: async (p) => {
      await saveGit(p)
      await expect(p.getByTestId('consent-dialog')).toContainText('Sync without encryption')
      await expect(p.getByRole('button', { name: 'Encrypt my notes first' })).toBeVisible()
    },
    close: closeAll,
  })
})

test('UI: Sync settings for git with the pseudonymous note, the token advice and the device-flow scope', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await stubInvoke(app, 'sync:git-auth-info', { deviceFlow: true, hasToken: false, hasDeviceToken: false })
  for (const auth of ['token', 'device'] as const) {
    await reviewUi(app, page, `sync git ${auth}`, {
      within: '[data-testid="sync-settings"]',
      scroll: '[data-testid="settings-body"]',
      open: async (p) => {
        await openSync(p)
        await p.getByTestId('sync-provider-git').check()
        await p.getByTestId(`git-auth-${auth}`).check()
        await expect(p.getByTestId('sync-pseudonymous')).toBeVisible()
        await expect(p.getByTestId(auth === 'token' ? 'git-token-help' : 'git-device-scope')).toBeVisible()
      },
      close: closeAll,
    })
  }
})

test('UI: turning sync off offers Turn off and Turn off and forget this connection', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  for (const saved of ['git', 'onedrive'] as const) {
    await reviewUi(app, page, `sync turn off ${saved}`, {
      within: '[data-testid="sync-settings"]',
      scroll: '[data-testid="settings-body"]',
      open: async (p) => {
        await p.evaluate((patch) => window.slate.settings.set(patch), saved === 'git' ? GIT : { syncProvider: 'onedrive' as const })
        await openSync(p)
        await p.getByTestId('sync-provider-off').check()
        await expect(p.getByTestId('sync-forget')).toBeVisible()
        await expect(p.getByTestId('sync-settings-save')).toHaveText('Turn off')
        await expect(p.getByTestId('sync-forget-sign-out')).toHaveCount(saved === 'onedrive' ? 1 : 0)
      },
      close: closeAll,
    })
  }
})
