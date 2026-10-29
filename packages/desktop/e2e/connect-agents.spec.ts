import { expect, test, clickMenu } from './fixtures'

test('Help → Connect AI agents shows the claude mcp add command', async ({ app, page }) => {
  const dialog = page.getByTestId('connect-agents')
  // A menu click sent before the renderer listens for it is dropped, so click until the dialog opens.
  await expect(async () => {
    await clickMenu(app, 'connect-agents')
    await expect(dialog).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
  const command = page.getByTestId('connect-agents-command')
  await expect(command).toContainText('claude mcp add slate -- "')
  await expect(command).toContainText(/bin\/slate-mcp"$/)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})
