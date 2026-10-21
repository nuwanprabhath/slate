import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoxAt,MOD, expect, launchApp, test } from './fixtures'
import { connectMcp, textOf } from './mcpClient'

test('an agent reads shared notes without private boxes, writes live into the open app, and is audited', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData)
  const focused = page.locator('[data-testid="box-editor"]:focus')

  await createBoxAt(page, 60, 60)
  await expect(focused).toHaveText('')
  await page.keyboard.type('visible ')
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.type('bold')
  await createBoxAt(page, 60, 260)
  await expect(focused).toHaveText('')
  await page.keyboard.type('API_KEY=hunter2')
  const secret = page.getByTestId('box').filter({ hasText: 'hunter2' })
  await secret.hover()
  await secret.getByTestId('box-lock').click()

  await page.getByTestId('notebook-picker').click()
  await page.getByRole('menuitem', { name: /AI can read & write$/ }).click()
  await page.waitForTimeout(300)

  const { client, close } = await connectMcp(userData)
  const tree = JSON.parse(textOf(await client.callTool({ name: 'list_tree', arguments: {} })))
  const section = tree[0].items[0]
  const pageId: string = section.children[0].pageId

  const md = textOf(await client.callTool({ name: 'read_page', arguments: { pageId } }))
  expect(md).toContain('visible **bold**')
  expect(md).toContain('[private box omitted]')
  expect(md).not.toContain('hunter2')
  expect(JSON.parse(textOf(await client.callTool({ name: 'search', arguments: { query: 'hunter2' } })))).toEqual([])

  await client.callTool({ name: 'append_to_page', arguments: { pageId, markdown: 'note from the agent' } })
  await expect(page.getByTestId('box').filter({ hasText: 'note from the agent' })).toBeVisible({ timeout: 5000 })

  await client.callTool({
    name: 'create_page',
    arguments: { notebookId: tree[0].notebookId, sectionId: section.id, title: 'Agent runbook', markdown: 'step 1' },
  })
  await expect(page.getByTestId('page-item').filter({ hasText: 'Agent runbook' })).toBeVisible({ timeout: 5000 })
  await close()

  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('ai-activity')!.click())
  const rows = page.getByTestId('ai-activity-row')
  await expect(rows.filter({ hasText: 'append_to_page' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'read_page' })).toHaveCount(1)
  await app.close()
})
