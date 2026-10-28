import type { Page } from '@playwright/test'
import { expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'
import { unlockedApp } from './states'

async function openSecurity(page: Page): Promise<void> {
  if (!(await page.getByTestId('settings-dialog').isVisible())) await page.keyboard.press(`${MOD}+,`)
  await page.getByTestId('settings-nav-security').click()
  await expect(page.getByTestId('security-change-password')).toBeVisible()
}

/** Settings → Security of an encrypted vault, the change-password form first. */
test('UI: Security section of an encrypted vault', async () => {
  test.setTimeout(240_000)
  const { app, page } = await unlockedApp()
  try {
    await reviewUi(app, page, 'security encrypted', { open: openSecurity, scroll: '[data-testid="settings-pane"]' })
    // Change password alone, so its screenshot shows the whole form; then with a weak password typed.
    await reviewUi(app, page, 'security change password', {
      within: '[data-testid="security-change-password"]',
      open: async (p) => {
        await openSecurity(p)
        await p.getByTestId('security-change-password').scrollIntoViewIfNeeded()
      },
    })
    await reviewUi(app, page, 'security change password weak', {
      within: '[data-testid="security-change-password"]',
      open: async (p) => {
        await openSecurity(p)
        await p.getByTestId('security-new').fill('short')
        await expect(p.getByTestId('security-new-strength')).not.toContainText('A few unrelated words')
        await p.getByTestId('security-change-password').scrollIntoViewIfNeeded()
      },
    })
  } finally {
    await app.close()
  }
})
