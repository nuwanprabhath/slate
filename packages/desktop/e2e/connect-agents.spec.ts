import { expect, test } from './fixtures'

test('Help → Connect AI agents shows the claude mcp add command', async ({ app, page }) => {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('connect-agents')!.click())
  const dialog = page.getByTestId('connect-agents')
  await expect(dialog).toBeVisible()
  const command = page.getByTestId('connect-agents-command')
  await expect(command).toContainText('claude mcp add slate -- "')
  await expect(command).toContainText(/bin\/slate-mcp"$/)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})
