import { expect, test } from './fixtures'

test('boots and round-trips a document through IPC', async ({ page }) => {
  await expect(page).toHaveTitle('Slate')
  const bytes = await page.evaluate(async () => {
    await window.slate.docs.append('test:1', new Uint8Array([1, 2, 3]))
    return Array.from((await window.slate.docs.load('test:1'))[0]!)
  })
  expect(bytes).toEqual([1, 2, 3])
})

test('keeps the window hidden during e2e runs', async ({ app }) => {
  // CI shows it on a virtual display (SLATE_E2E_SHOW, see src/main/index.ts); everywhere else it stays hidden.
  const shown = process.env.SLATE_E2E_SHOW === '1'
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())
  expect(visible).toBe(shown)
})

test('every window runs sandboxed and isolated, with no Node and web security on', async ({ app, page }) => {
  await expect(page).toHaveTitle('Slate')
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => {
      // Present at run time (Electron 45); the bundled typings lag.
      const p = (w.webContents as unknown as { getLastWebPreferences(): Record<string, boolean | undefined> | null }).getLastWebPreferences()
      return { sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration ?? false, webSecurity: p?.webSecurity ?? true }
    }),
  )
  expect(prefs.length).toBeGreaterThan(0)
  for (const p of prefs) expect(p).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
})
