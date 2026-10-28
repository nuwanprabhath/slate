import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from '../fixtures'
import { reviewUi } from './review'
import { reloadTo, sendEvent, stubInvoke } from './states'

/** The title bar alone and with each banner under it. */
test('UI: title bar', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await reviewUi(app, page, 'title bar')
})

test('UI: title bar with an update available', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb' })
  try {
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 30_000 })
    await reviewUi(app, page, 'banner update')
  } finally {
    await app.close()
  }
})

for (const problem of ['join-needed', 'other-vault', 'not-encrypted'] as const) {
  test(`UI: title bar with the vault banner (${problem})`, async ({ app, page }) => {
    await expect(page.getByTestId('canvas')).toBeVisible()
    const state = { ...(await page.evaluate(() => window.slate.sync.status())), vaultProblem: problem, plaintextWarning: problem === 'not-encrypted' }
    await stubInvoke(app, 'sync:status', state)
    // Re-sent on every pass: a theme change is a settings write, after which main sends the real status.
    await reviewUi(app, page, `banner vault ${problem}`, {
      open: async (p) => {
        await sendEvent(app, 'sync:status-event', state)
        const banner = p.getByTestId(problem === 'not-encrypted' ? 'vault-remote-plain-banner' : 'vault-join-banner')
        await expect(banner).toBeVisible()
        // The reported defect: the banner's button was cut by the window's top edge, over the title bar.
        const [bar, box] = await Promise.all([p.getByTestId('title-bar').boundingBox(), banner.boundingBox()])
        expect(box!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height)
      },
    })
  })
}

test('UI: title bar with an unfinished migration and the quick unlock offer', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  const status = await page.evaluate(() => window.slate.vault.status())
  await stubInvoke(app, 'vault:status', { ...status, state: 'migrating' })
  await stubInvoke(app, 'vault:quick-unlock-info', { kind: 'touchid', enabled: false, offerReenable: true })
  await reloadTo(page, 'migration-banner')
  await expect(page.getByTestId('quick-unlock-offer')).toBeVisible()
  await reviewUi(app, page, 'banner migration')
  await page.getByTestId('migration-finish').click()
  await reviewUi(app, page, 'banner migration password')
})
