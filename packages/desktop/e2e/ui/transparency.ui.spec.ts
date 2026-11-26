import type { ElectronApplication, Page } from '@playwright/test'
import { clickMenu, expect, test } from '../fixtures'
import type { PrivacyStatus } from '../../src/shared/api'
import { reviewUi } from './review'
import { stubInvoke } from './states'

const dialog = (page: Page) => page.getByTestId('consent-dialog')
const status = (page: Page) => page.evaluate(() => window.slate.privacy.status()) as Promise<PrivacyStatus>

async function openSection(app: ElectronApplication, page: Page, id: string): Promise<void> {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await app.evaluate(({ BrowserWindow }, section) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:command', { cmd: 'show-settings', section }), id)
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.getByTestId(`settings-nav-${id}`).click()
}

const openAiActivity = async (app: ElectronApplication, page: Page) => {
  await expect(async () => {
    await clickMenu(app, 'ai-activity')
    await expect(page.getByTestId('ai-activity')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
}

const ROWS = [
  { id: 2, ts: 1_700_000_100_000, tool: 'search', target: '[12 chars]', outcome: 'ok' },
  { id: 1, ts: 1_700_000_000_000, tool: 'read_page', target: 'page-1', outcome: 'ok' },
]

test('UI: Updates section names the recipient; ticking automatic asks for consent', async ({ app, page }) => {
  await openSection(app, page, 'updates')
  const section = page.getByTestId('updates-section')
  await expect(section).toContainText('github.com')
  await expect(section).toContainText('objects.githubusercontent.com')
  await expect(section).toContainText('GitHub, Inc. (USA)')
  await expect(section.getByTestId('setting-update-automatic')).not.toBeChecked()
  await reviewUi(app, page, 'updates section strict', { open: async (p) => expect(p.getByTestId('updates-section')).toBeVisible() })
  await section.getByTestId('setting-update-automatic').click()
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(section.getByTestId('setting-update-automatic')).not.toBeChecked()
  expect((await status(page)).allowed.updates).toBe(false)
  await section.getByTestId('setting-update-automatic').click()
  await dialog(page).getByRole('button', { name: 'Allow' }).click()
  await expect(section.getByTestId('setting-update-automatic')).toBeChecked()
  await expect(section.getByTestId('setting-update-interval')).toBeVisible()
  expect((await status(page)).allowed.updates).toBe(true)
  await page.evaluate(() => window.slate.privacy.revoke('updates'))
  await expect(section.getByTestId('setting-update-automatic')).not.toBeChecked()
})

test('Diagnostics says what the security record keeps and how searches are recorded', async ({ app, page }) => {
  await openSection(app, page, 'diagnostics')
  const text = page.getByTestId('diagnostics-privacy')
  await expect(text).toContainText('no search queries (AI agents’ searches are recorded only as their length)')
  await expect(page.getByTestId('diagnostics-security-record')).toContainText(
    'Slate also keeps a short security record (unlocks and locks, no notes) for 30 days in strict mode, or 90 days with strict mode off or under FIPS; see Settings → Privacy.',
  )
})

test('UI: Appearance offers Describe a theme with Claude before any consent; Escape records nothing', async ({ app, page }) => {
  await openSection(app, page, 'appearance')
  const ask = page.getByTestId('theme-describe-ask')
  await expect(ask).toBeVisible()
  await expect(page.getByTestId('theme-describe-consent')).toContainText('Anthropic')
  await reviewUi(app, page, 'appearance describe with claude', { open: async (p) => expect(p.getByTestId('theme-describe-ask')).toBeVisible() })
  await ask.click()
  await expect(dialog(page)).toContainText('Anthropic')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByTestId('theme-describe')).toHaveCount(0)
  expect((await status(page)).consents).toEqual({})
})

test('Import: Sign in to Microsoft asks for consent first; backup files need none', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await stubInvoke(app, 'onenote:status', { configured: true, signedIn: false })
  await expect(async () => {
    await clickMenu(app, 'import-onenote')
    await expect(page.getByTestId('import-dialog')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
  await expect(page.getByTestId('import-from-backup')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
  await page.getByTestId('import-sign-in').click()
  await expect(dialog(page)).toContainText('Sign in to Microsoft')
  await expect(dialog(page).getByTestId('consent-endpoints')).toContainText('login.microsoftonline.com')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  expect((await status(page)).allowed.microsoftSignIn).toBe(false)
})

test('AI Activity: Clear asks inline, Escape backs out of the question, Delete empties the list', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await stubInvoke(app, 'audit:list', ROWS)
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { auditCleared: number }
    g.auditCleared = 0
    ipcMain.removeHandler('audit:clear')
    ipcMain.handle('audit:clear', () => void (g.auditCleared += 1))
  })
  await openAiActivity(app, page)
  const panel = page.getByTestId('ai-activity')
  await expect(panel.getByTestId('ai-activity-row')).toHaveCount(2)
  await panel.getByTestId('ai-activity-clear').click()
  await expect(panel.getByTestId('ai-activity-confirm')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel.getByTestId('ai-activity-confirm')).toHaveCount(0)
  await expect(panel).toBeVisible()
  expect(await app.evaluate(() => (globalThis as unknown as { auditCleared: number }).auditCleared)).toBe(0)
  await panel.getByTestId('ai-activity-clear').click()
  await panel.getByTestId('ai-activity-clear-confirm').click()
  await expect(panel.getByTestId('ai-activity-row')).toHaveCount(0)
  await expect(panel).toContainText('No AI activity yet')
  await expect(panel.getByTestId('ai-activity-clear')).toBeDisabled()
  expect(await app.evaluate(() => (globalThis as unknown as { auditCleared: number }).auditCleared)).toBe(1)
})

test('UI: AI Activity with the Clear question open', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await stubInvoke(app, 'audit:list', ROWS)
  await reviewUi(app, page, 'ai activity clear confirm', {
    open: async (p) => {
      if ((await p.getByTestId('ai-activity').count()) === 0) await openAiActivity(app, p)
      if ((await p.getByTestId('ai-activity-confirm').count()) === 0) await p.getByTestId('ai-activity-clear').click()
      await expect(p.getByTestId('ai-activity-confirm')).toBeVisible()
    },
    close: async (p) => {
      await p.keyboard.press('Escape')
      await p.keyboard.press('Escape')
      await expect(p.getByTestId('ai-activity')).toHaveCount(0)
    },
  })
})

test('Connect AI agents says what the provider may receive', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await expect(async () => {
    await clickMenu(app, 'connect-agents')
    await expect(page.getByTestId('connect-agents')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
  await expect(page.getByTestId('connect-agents-provider')).toHaveText('Agents you connect may send what they read to their provider (for Claude Code: Anthropic).')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('connect-agents')).toHaveCount(0)
})
