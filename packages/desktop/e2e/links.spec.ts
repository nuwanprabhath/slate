import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

const editor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')
const writeText = (app: ElectronApplication, text: string) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
const paste = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.paste())

async function boxWith(page: Page, text: string) {
  await createBoxAt(page, 120, 120)
  await expect(editor(page)).toHaveText('')
  await page.keyboard.type(text)
  await expect(editor(page)).toHaveText(text)
}

/** Selects the last `n` characters. */
async function selectLast(page: Page, n: number) {
  await page.evaluate((count) => {
    const sel = window.getSelection()
    for (let i = 0; i < count; i++) sel?.modify('extend', 'backward', 'character')
  }, n)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length)).toBe(n)
  // ProseMirror learns of a DOM selection change on selectionchange, which a loaded machine delivers late:
  // wait until the editor's own state holds the selection (TipTap keeps its editor on the view's DOM node),
  // or a paste lands on a collapsed caret.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dom = document.activeElement as (Element & { editor?: { state: { selection: { from: number; to: number } } } }) | null
        const sel = dom?.editor?.state.selection
        return sel ? sel.to - sel.from : -1
      }),
    )
    .toBe(n)
}

test('Mod+K links the selected word, prefills on edit and removes', async ({ page }) => {
  await boxWith(page, 'visit site')
  await selectLast(page, 4)
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('link-popover')).toBeVisible()
  await expect(page.getByTestId('link-remove')).toHaveCount(0)
  await page.getByTestId('link-input').fill('example.com')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('link-popover')).toHaveCount(0)
  const link = page.locator('[data-testid="box-editor"] a')
  await expect(link).toHaveText('site')
  await expect(link).toHaveAttribute('href', 'https://example.com')

  // The popover hands focus back asynchronously; a key sent before that is lost.
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(3)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('link-input')).toHaveValue('https://example.com')
  await page.getByTestId('link-remove').click()
  await expect(link).toHaveCount(0)
  await expect(editor(page)).toHaveText('visit site')
})

test('javascript: links are rejected', async ({ page }) => {
  await boxWith(page, 'bad link')
  await selectLast(page, 4)
  await page.keyboard.press(`${MOD}+k`)
  await page.getByTestId('link-input').fill('javascript:alert(1)')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('link-error')).toBeVisible()
  await expect(page.locator('[data-testid="box-editor"] a')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('link-popover')).toHaveCount(0)
})

test('Mod+K on a bare caret inserts linked text', async ({ page }) => {
  await boxWith(page, 'see ')
  await page.keyboard.press(`${MOD}+k`)
  await page.getByTestId('link-text-input').fill('docs')
  await page.getByTestId('link-input').fill('example.com/docs')
  await page.keyboard.press('Enter')
  const link = page.locator('[data-testid="box-editor"] a')
  await expect(link).toHaveText('docs')
  await expect(link).toHaveAttribute('href', 'https://example.com/docs')
})

test('pasting a URL onto selected text links it and keeps the text', async ({ app, page }) => {
  await boxWith(page, 'my repo')
  await selectLast(page, 4)
  await writeText(app, 'https://github.com')
  await paste(app)
  const link = page.locator('[data-testid="box-editor"] a')
  await expect(link).toHaveText('repo')
  await expect(link).toHaveAttribute('href', 'https://github.com')
  await expect(editor(page)).toHaveText('my repo')
})

test('a pasted URL becomes a link by default, also inside pasted text', async ({ app, page }) => {
  await boxWith(page, 'go to ')
  await writeText(app, 'https://github.com')
  await paste(app)
  await expect(editor(page)).toHaveText('go to https://github.com')
  const link = page.locator('[data-testid="box-editor"] a')
  await expect(link).toHaveText('https://github.com')
  await expect(link).toHaveAttribute('href', 'https://github.com')

  await writeText(app, ' and the docs at www.example.com/docs.')
  await paste(app)
  await expect(editor(page)).toHaveText('go to https://github.com and the docs at www.example.com/docs.')
  await expect(link.nth(1)).toHaveText('www.example.com/docs')
  await expect(link.nth(1)).toHaveAttribute('href', 'https://www.example.com/docs')
})

test('a URL pasted onto the bare canvas becomes a link in the new box', async ({ app, page }) => {
  await page.getByTestId('canvas').click({ position: { x: 200, y: 200 } })
  await writeText(app, 'https://github.com')
  await page.keyboard.press(`${MOD}+v`)
  const link = page.locator('[data-testid="box-editor"] a')
  await expect(link).toHaveAttribute('href', 'https://github.com')
})

test('paste as plain text, and the setting off, insert the URL as text', async ({ app, page }) => {
  await boxWith(page, 'plain ')
  await writeText(app, 'https://github.com')
  await page.keyboard.press(`${MOD}+Shift+v`)
  await expect(editor(page)).toHaveText('plain https://github.com')
  await expect(page.locator('[data-testid="box-editor"] a')).toHaveCount(0)

  await page.evaluate(() => window.slate.settings.set({ linkPastedUrls: false }))
  await page.locator('[data-testid="box-editor"]').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' off ')
  await paste(app)
  await expect(page.locator('[data-testid="box-editor"]')).toHaveText('plain https://github.com off https://github.com')
  await expect(page.locator('[data-testid="box-editor"] a')).toHaveCount(0)
})
