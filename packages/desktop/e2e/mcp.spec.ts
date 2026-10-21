import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'
import { connectMcp, textOf } from './mcpClient'

test('slate-mcp starts over stdio and denies by default', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app } = await launchApp(userData) // creates the default notebook
  await app.close()
  const { client, close } = await connectMcp(userData)
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort()).toEqual(['append_to_page', 'create_page', 'list_tree', 'read_page', 'search'])
  expect(JSON.parse(textOf(await client.callTool({ name: 'list_tree', arguments: {} })))).toEqual([])
  const denied = await client.callTool({ name: 'read_page', arguments: { pageId: 'anything' } })
  expect(denied.isError).toBe(true)
  expect(textOf(denied)).toBe('not found or not permitted')
  await close()
})
