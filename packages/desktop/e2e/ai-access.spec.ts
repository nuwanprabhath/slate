import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test, clickMenu } from './fixtures'

test('a section can be shared with AI, shows a badge, and stays shared after restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  const section = first.page.getByTestId('section-item').first()
  await expect(section.getByTestId('ai-badge')).toHaveCount(0)
  await section.click({ button: 'right' })
  await first.page.getByRole('menuitem', { name: /AI can read$/ }).click()
  await expect(section.getByTestId('ai-badge')).toHaveText('AI')
  await first.page.waitForTimeout(300)
  await first.app.close()
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('section-item').first().getByTestId('ai-badge')).toBeVisible()
  await second.page.getByTestId('section-item').first().click({ button: 'right' })
  await expect(second.page.getByRole('menuitem', { name: /✓ AI can read$/ })).toBeVisible()
  await second.app.close()
})

test('the notebook itself can be shared from the notebook menu', async ({ page }) => {
  await page.getByTestId('notebook-picker').click()
  await page.getByRole('menuitem', { name: /AI can read & write$/ }).click()
  await expect(page.getByTestId('notebook-picker').getByTestId('ai-badge')).toBeVisible()
})

test('View → AI Activity opens the audit panel', async ({ app, page }) => {
  await clickMenu(app, 'ai-activity')
  await expect(page.getByTestId('ai-activity')).toContainText('No AI activity yet')
  await page.getByTestId('ai-activity-close').click()
  await expect(page.getByTestId('ai-activity')).toHaveCount(0)
})
