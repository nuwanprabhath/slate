import { expect, test } from './fixtures'

test('boots and round-trips a document through IPC', async ({ page }) => {
  await expect(page).toHaveTitle('Slate')
  const bytes = await page.evaluate(async () => {
    await window.slate.docs.append('test:1', new Uint8Array([1, 2, 3]))
    return Array.from((await window.slate.docs.load('test:1'))[0])
  })
  expect(bytes).toEqual([1, 2, 3])
})

test('keeps the window hidden during e2e runs', async ({ app }) => {
  // CI shows it on a virtual display (SLATE_E2E_SHOW, see src/main/index.ts); everywhere else it stays hidden.
  const shown = process.env.SLATE_E2E_SHOW === '1'
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  expect(visible).toBe(shown)
})
