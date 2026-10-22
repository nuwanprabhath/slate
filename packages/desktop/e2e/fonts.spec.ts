import type { Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

async function openAppearance(page: Page) {
  await page.keyboard.press(`${MOD}+,`)
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.locator('.settings-nav-item', { hasText: 'Appearance' }).click()
  await expect(page.getByTestId('settings-heading')).toHaveText('Appearance')
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
}

const chooseTheme = (page: Page, id: string) => page.locator(`[data-testid="theme-card"][data-theme-id="${id}"]`).click()
const fontOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily)
const rootVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)

async function setFont(page: Page, which: 'note' | 'app', name: string) {
  const input = page.getByTestId(`setting-${which}-font`)
  await input.fill(name)
  await input.press('Enter')
}

test('the sidebar columns and their footers use one font, in Paper too', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await openAppearance(page)
  await chooseTheme(page, 'builtin:paper')
  await closeSettings(page)
  await expect(page.locator('.page-row')).not.toHaveCount(0)
  const section = await fontOf(page, '.tree-row:not(.page-row)')
  expect(await fontOf(page, '.page-row')).toBe(section)
  expect(await fontOf(page, '[data-testid="add-page"]')).toBe(await fontOf(page, '[data-testid="add-section"]'))
  expect(await fontOf(page, '[data-testid="add-page"]')).toBe(section)
})

test('the note font applies to plain text but not to a run with its own font', async ({ page }) => {
  await createBoxAt(page, 120, 120)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type('marked text')
  await page.keyboard.press(`${MOD}+a`)
  await page.getByTestId('tb-font').selectOption('monospace')
  await page.locator('[data-testid="box-editor"]').focus()
  await page.keyboard.press('ArrowRight')
  // ProseMirror adopts a native selection change on the next selectionchange event: let a frame pass.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="box-editor"] p')).toHaveCount(2)
  await page.getByTestId('tb-font').selectOption('')
  await page.locator('[data-testid="box-editor"]').focus()
  await page.keyboard.type('plain text')
  const marked = page.locator('[data-testid="box-editor"] span[style*="font-family"]', { hasText: 'marked' }).first()
  await expect(marked).toBeVisible()
  await expect(page.locator('[data-testid="box-editor"] span[style*="font-family"]', { hasText: 'plain' })).toHaveCount(0)
  await openAppearance(page)
  await setFont(page, 'note', 'Georgia')
  await closeSettings(page)
  const plain = page.locator('[data-testid="box-editor"] p', { hasText: 'plain text' })
  await expect.poll(() => plain.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Georgia')
  expect(await marked.evaluate((el) => getComputedStyle(el).fontFamily)).toBe('monospace')
})

test('the app font changes the toolbar, and each theme keeps its own override', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  const before = await fontOf(page, '.toolbar')
  await openAppearance(page)
  await chooseTheme(page, 'builtin:paper')
  await setFont(page, 'app', 'Menlo')
  await expect.poll(() => fontOf(page, '.toolbar')).toContain('Menlo')
  await setFont(page, 'note', 'Georgia')
  await expect.poll(() => rootVar(page, '--font-note')).toContain('Georgia')
  await chooseTheme(page, 'builtin:light')
  await expect.poll(() => fontOf(page, '.toolbar')).toBe(before)
  expect(await rootVar(page, '--font-note')).not.toContain('Georgia')
  await expect(page.getByTestId('setting-note-font')).toHaveValue('')
  await chooseTheme(page, 'builtin:paper')
  await expect.poll(() => rootVar(page, '--font-note')).toContain('Georgia')
  await expect.poll(() => fontOf(page, '.toolbar')).toContain('Menlo')
  await expect(page.getByTestId('setting-app-font')).toHaveValue('Menlo')
})

test('a font name that could escape CSS is refused', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await openAppearance(page)
  const before = await rootVar(page, '--font-note')
  await setFont(page, 'note', 'x;}body{color:red')
  await expect(page.getByTestId('setting-note-font')).toHaveAttribute('aria-invalid', 'true')
  expect(await rootVar(page, '--font-note')).toBe(before)
})

test('form controls follow the theme and the toolbar selects are not clipped', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await openAppearance(page)
  await chooseTheme(page, 'builtin:paper')
  const controlBg = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--control-bg)'
    document.body.append(probe)
    const c = getComputedStyle(probe).backgroundColor
    probe.remove()
    return c
  })
  expect(controlBg).toBe('rgb(251, 246, 234)')
  await expect(page.getByTestId('setting-motion')).toHaveCSS('background-color', controlBg)
  await expect(page.getByTestId('setting-motion')).toHaveCSS('appearance', 'none')
  await closeSettings(page)
  await createBoxAt(page, 120, 120)
  for (const id of ['tb-size', 'tb-font']) {
    const { scroll, client } = await page.getByTestId(id).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(scroll, id).toBeLessThanOrEqual(client)
  }
})
