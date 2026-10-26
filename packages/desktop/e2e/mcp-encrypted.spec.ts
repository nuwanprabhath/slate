import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'
import { connectMcp, textOf } from './mcpClient'

const PASSWORD = 'e2e mcp password'
const LOCKED = 'Slate is locked or not running. Unlock Slate to give AI access.'

test('slate-mcp on an encrypted folder: locked → status error, unlocked → real tools, locked again → error', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
  const mcp = await connectMcp(userData)
  try {
    await expect(page.getByTestId('lock-screen')).toBeVisible()
    const { tools } = await mcp.client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['slate_status'])
    const locked = await mcp.client.callTool({ name: 'list_tree', arguments: {} })
    expect(locked.isError).toBe(true)
    expect(textOf(locked)).toBe(LOCKED)

    await page.getByTestId('lock-secret').fill(PASSWORD)
    await page.getByTestId('lock-unlock').click()
    await expect.poll(async () => (await mcp.client.callTool({ name: 'list_tree', arguments: {} })).isError ?? false, { timeout: 15_000 }).toBe(false)
    expect(JSON.parse(textOf(await mcp.client.callTool({ name: 'list_tree', arguments: {} })))).toEqual([])
    expect((await mcp.client.listTools()).tools.map((t) => t.name)).toContain('read_page')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript('window.slate.vault.lock()'))
    await expect.poll(async () => textOf(await mcp.client.callTool({ name: 'list_tree', arguments: {} })), { timeout: 15_000 }).toBe(LOCKED)
  } finally {
    await mcp.close()
    await app.close()
  }
})
