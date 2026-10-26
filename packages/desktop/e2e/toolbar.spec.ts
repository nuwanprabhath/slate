import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

const focusedEditor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')
const copy = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy())
const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText())

async function typeSelected(page: Page, text: string) {
  await createBoxAt(page, 120, 160)
  await expect(focusedEditor(page)).toHaveText('')
  await page.keyboard.type(text)
  await page.keyboard.press(`${MOD}+a`)
}

const swatch = (page: Page, color: string) => page.locator(`.palette-popover [data-testid="palette-swatch"][data-color="${color}"]`).first()

test('the text-colour palette colours the selection and remembers the colour', async ({ page }) => {
  await typeSelected(page, 'paint me')
  await page.getByTestId('tb-color-menu').click()
  await swatch(page, '#ff0000').click()
  await expect(page.locator('.palette-popover')).toHaveCount(0)
  await expect(page.getByTestId('box-editor').locator('span[data-color="#ff0000"]')).toHaveText('paint me')
  await expect(focusedEditor(page)).toHaveCount(1)

  await page.getByTestId('tb-color-menu').click()
  await expect(page.getByTestId('palette-recent').getByTestId('palette-swatch').first()).toHaveAttribute('data-color', '#ff0000')
  await page.getByTestId('palette-auto').click()
  await expect(page.getByTestId('box-editor').locator('span[data-color]')).toHaveCount(0)
})

test('the palette is keyboard navigable and closes on Escape', async ({ page }) => {
  await typeSelected(page, 'keys')
  await page.getByTestId('tb-color-menu').click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('box-editor').locator('span[data-color="#ff0000"]')).toHaveText('keys')
  await page.getByTestId('tb-color-menu').click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-popover')).toHaveCount(0)
  await expect(page.getByTestId('box-editor')).toHaveText('keys')
})

test('highlight applies a colour and "No highlight" removes it', async ({ page }) => {
  await typeSelected(page, 'mark me')
  await page.getByTestId('tb-highlight-menu').click()
  await swatch(page, '#1e90ff').click()
  await expect(page.getByTestId('box-editor').locator('mark[data-color="#1e90ff"]')).toHaveText('mark me')
  await page.getByTestId('tb-highlight-menu').click()
  await page.getByTestId('palette-auto').click()
  await expect(page.getByTestId('box-editor').locator('mark')).toHaveCount(0)
})

test('hovering or clicking clear formatting leaves the highlight control alone', async ({ page }) => {
  await typeSelected(page, 'clear me')
  await page.getByTestId('tb-clear').hover()
  const hovered = await page.evaluate(() => [...document.querySelectorAll(':hover')].map((el) => el.getAttribute('data-testid')).filter(Boolean))
  expect(hovered).toContain('tb-clear')
  expect(hovered).not.toContain('tb-highlight')
  await page.getByTestId('tb-clear').click()
  await expect(page.locator('.palette-popover')).toHaveCount(0)
  await expect(page.getByTestId('tb-highlight-menu')).toHaveAttribute('aria-expanded', 'false')
})

test('the a. numbering style shows letters and copies as a.', async ({ app, page }) => {
  await createBoxAt(page, 120, 160)
  await expect(focusedEditor(page)).toHaveText('')
  await page.keyboard.type('first')
  await page.getByTestId('tb-ordered-menu').click()
  await page.getByTestId('list-style-lower-alpha').click()
  const ol = page.getByTestId('box-editor').locator('ol')
  await expect(ol).toHaveCSS('list-style-type', 'lower-alpha')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second')
  await page.keyboard.press(`${MOD}+a`)
  await copy(app)
  await expect.poll(() => clipboardText(app)).toBe('a. first\nb. second')
})

test('the box padlock toggles private', async ({ page }) => {
  await createBoxAt(page, 120, 160)
  const lock = page.getByTestId('box-lock')
  await expect(lock).toHaveAttribute('aria-pressed', 'false')
  await expect(lock).toHaveAttribute('title', 'Visible to AI agents — click to make private')
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'true')
  await expect(lock).toHaveAttribute('title', 'Private: hidden from AI agents — click to share')
})
