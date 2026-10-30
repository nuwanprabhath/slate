import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { clickMenu, createBoxAt, expect, MOD, test } from './fixtures'
import { boxWithText } from './canvasHelpers'
import { unlockedApp } from './ui/states'

const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText())
const clipboardTypes = (app: ElectronApplication) =>
  app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read()
    return item?.types ?? []
  })
const writeText = (app: ElectronApplication, text: string) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)

/** A box holding "ship **it**", all of it selected. */
async function selectedBoldText(page: Page) {
  const box = await boxWithText(page, 120, 120, 'ship ')
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.type('it')
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.press(`${MOD}+a`)
  return box.getByTestId('box-editor')
}

/** Right-clicks on the text itself: past the selection's end, a right-click moves the caret there instead. */
const rightClickText = (editor: Locator) => editor.locator('p').first().click({ button: 'right', position: { x: 10, y: 8 } })

test('right-click → Copy as Markdown puts the selection on the clipboard as Markdown text', async ({ app, page }) => {
  const editor = await selectedBoldText(page)
  await writeText(app, 'before')
  await rightClickText(editor)
  await expect(page.getByTestId('text-menu')).toBeVisible()
  await page.getByTestId('text-menu-copy-markdown').click()
  await expect(page.getByTestId('text-menu')).toHaveCount(0)
  await expect.poll(() => clipboardText(app)).toBe('ship **it**')
  const types = await clipboardTypes(app)
  expect(types).toContain('text/plain')
  expect(types).not.toContain('text/html')
  // The selection and the focus are still the box's.
  await expect(editor).toBeFocused()
})

test('Mod+Alt+Shift+C copies the selection as Markdown too', async ({ app, page }) => {
  await selectedBoldText(page)
  await writeText(app, 'before')
  await page.keyboard.press(`${MOD}+Alt+Shift+c`)
  await expect.poll(() => clipboardText(app)).toBe('ship **it**')
})

test('Edit → Copy as Markdown copies the selection as Markdown', async ({ app, page }) => {
  await selectedBoldText(page)
  await writeText(app, 'before')
  await clickMenu(app, 'copy-markdown')
  await expect.poll(() => clipboardText(app)).toBe('ship **it**')
})

test('with nothing selected, Cut, Copy and Copy as Markdown are disabled and Paste pastes', async ({ app, page }) => {
  await createBoxAt(page, 120, 120)
  const editor = page.locator('[data-testid="box-editor"]:focus')
  await expect(editor).toHaveText('')
  await writeText(app, 'from the clipboard')
  await editor.click({ button: 'right' })
  for (const id of ['text-menu-cut', 'text-menu-copy', 'text-menu-copy-markdown']) await expect(page.getByTestId(id)).toBeDisabled()
  for (const id of ['text-menu-paste', 'text-menu-paste-plain', 'text-menu-select-all']) await expect(page.getByTestId(id)).toBeEnabled()
  await page.getByTestId('text-menu-paste').click()
  await expect(page.getByTestId('box-editor')).toHaveText('from the clipboard')
  // The empty box was not removed when its menu opened: it is the one that got the text.
  await expect(page.getByTestId('box-editor')).toHaveCount(1)
})

test('the menu cuts and copies through the same path as the keys, and pastes as plain text', async ({ app, page }) => {
  const editor = await selectedBoldText(page)
  await rightClickText(editor)
  await page.getByTestId('text-menu-copy').click()
  await expect.poll(() => clipboardText(app)).toBe('ship it')
  expect(await clipboardTypes(app)).toContain('text/html')

  await rightClickText(editor)
  await page.getByTestId('text-menu-cut').click()
  await expect(editor).toHaveText('')

  await rightClickText(editor)
  await page.getByTestId('text-menu-paste-plain').click()
  await expect(editor).toHaveText('ship it')
  await expect(editor.locator('strong')).toHaveCount(0)

  await rightClickText(editor)
  await page.getByTestId('text-menu-select-all').click()
  await rightClickText(editor)
  await expect(page.getByTestId('text-menu-copy')).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('text-menu')).toHaveCount(0)
})

test('a page cannot run Paste by itself: main wants a real press on the window first', async ({ app, page }) => {
  await createBoxAt(page, 120, 120)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await writeText(app, 'from the clipboard')
  // Long after the double-click that made the box: no press on the window in the last second.
  await page.waitForTimeout(1500)
  const outcome = await page.evaluate(() => window.slate.editCommand('paste').then(() => 'ran', (e: unknown) => String(e)))
  expect(outcome).toContain('no recent user input')
  await expect(page.getByTestId('box-editor')).toHaveText('')
})

test('the lock clears what Copy as Markdown put on the clipboard', async () => {
  const { app, page } = await unlockedApp()
  try {
    const editor = await selectedBoldText(page)
    await rightClickText(editor)
    await page.getByTestId('text-menu-copy-markdown').click()
    await expect.poll(() => clipboardText(app)).toBe('ship **it**')
    // Main records the copy 50 ms after the page reports it (index.ts, vaultCopied); a person is never that quick.
    await page.waitForTimeout(300)
    // The lock replaces this window on the key-down, so the key-up may find the page closed: that is the lock working.
    await page.keyboard.press(`${MOD}+Shift+L`).catch((e: Error) => {
      if (!/Target page, context or browser has been closed/.test(e.message)) throw e
    })
    await expect.poll(() => clipboardText(app), { timeout: 15_000 }).toBe('')
  } finally {
    await app.close()
  }
})
