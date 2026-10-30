import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

/** Phase 15 WP-C1 in the real window: to-do lists, alignment, sub- and superscript. */
const focusedEditor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')
const copy = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy())
const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText())
const clipboardHtml = (app: ElectronApplication) =>
  app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read()
    return item?.types.includes('text/html') ? (await item.getType('text/html')).text() : ''
  })

async function newBox(page: Page, text: string) {
  await createBoxAt(page, 120, 160)
  await expect(focusedEditor(page)).toHaveText('')
  await page.keyboard.type(text)
}

/** The point inside an item's box, which is drawn in the gutter left of its text. */
async function clickBox(page: Page, item: ReturnType<Page['locator']>) {
  const text = (await item.locator('> p').boundingBox())!
  await page.mouse.click(text.x - 12, text.y + text.height / 2)
}

test('to-do list from the toolbar: tick by clicking the box, nest with Tab, copy as - [ ] text', async ({ app, page }) => {
  await newBox(page, 'milk')
  await page.getByTestId('tb-todo').click()
  const editor = page.getByTestId('box-editor')
  await expect(editor.locator('li[data-checked="false"]')).toHaveText('milk')
  await expect(page.getByTestId('tb-todo')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('tb-bullet')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Enter')
  await page.keyboard.type('brown eggs')
  await page.keyboard.press('Tab')
  await expect(editor.locator('li li[data-checked="false"]')).toHaveText('brown eggs')

  await clickBox(page, editor.locator('li').first())
  await expect(editor.locator('li').first()).toHaveAttribute('data-checked', 'true')
  await expect(editor.locator('li').first().locator('> p')).toHaveCSS('text-decoration-line', 'line-through')
  await expect(editor.locator('li li')).toHaveAttribute('data-checked', 'false')

  await page.keyboard.press(`${MOD}+a`)
  await copy(app)
  await expect.poll(() => clipboardText(app)).toBe('- [x] milk\n  - [ ] brown eggs')
  await expect.poll(() => clipboardHtml(app)).toContain('data-type="taskList"')
})

test('Mod+Shift+9 makes a to-do list; typed `[ ] ` stays text', async ({ page }) => {
  await newBox(page, '[ ] not a task')
  const editor = page.getByTestId('box-editor')
  await expect(editor.locator('li')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+Shift+9`)
  await expect(editor.locator('li[data-checked="false"]')).toHaveText('[ ] not a task')
  await page.keyboard.press(`${MOD}+Shift+9`)
  await expect(editor.locator('li')).toHaveCount(0)
})

test('alignment from the menu and the shortcuts, copied as text-align', async ({ app, page }) => {
  await newBox(page, 'centred')
  const line = page.getByTestId('box-editor').locator('p')
  await page.getByTestId('tb-align').click()
  await page.getByTestId('align-center').click()
  await expect(line).toHaveCSS('text-align', 'center')
  await expect(page.getByTestId('align-center')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+Shift+r`)
  await expect(line).toHaveCSS('text-align', 'right')
  await page.keyboard.press(`${MOD}+Alt+Shift+l`)
  await expect(line).toHaveCSS('text-align', 'start')
  await page.keyboard.press(`${MOD}+Shift+e`)
  await expect(line).toHaveCSS('text-align', 'center')
  await page.keyboard.press(`${MOD}+a`)
  await copy(app)
  await expect.poll(() => clipboardHtml(app)).toContain('text-align: center')
})

test('subscript and superscript buttons and shortcuts exclude each other', async ({ page }) => {
  await newBox(page, 'H2O')
  const editor = page.getByTestId('box-editor')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.getByTestId('tb-subscript').click()
  await expect(editor.locator('sub')).toHaveText('2')
  await expect(page.getByTestId('tb-subscript')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press(`${MOD}+Shift+.`)
  await expect(editor.locator('sup')).toHaveText('2')
  await expect(editor.locator('sub')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+Shift+.`)
  await expect(editor.locator('sup')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+Shift+,`)
  await expect(editor.locator('sub')).toHaveText('2')
  await expect(editor).toHaveText('H2O')
})
