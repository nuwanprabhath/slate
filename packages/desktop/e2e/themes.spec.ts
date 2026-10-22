import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { writeFakeConverter } from '../../importer/test/fakeOne2html'
import { createBoxAt, expect, launchApp, MOD, test, clickMenu } from './fixtures'

async function openAppearance(page: Page) {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.keyboard.press(`${MOD}+,`)
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.locator('.settings-nav-item', { hasText: 'Appearance' }).click()
  await expect(page.getByTestId('settings-heading')).toHaveText('Appearance')
}

const card = (page: Page, id: string) => page.locator(`[data-testid="theme-card"][data-theme-id="${id}"]`)
const rootVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
const rootAttr = (page: Page, name: string) => page.evaluate((n) => document.documentElement.getAttribute(n), name)

/** WCAG contrast of `fg` over the page colour composited on the window colour, all read from the DOM. */
async function textContrast(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const parse = (c: string) => {
      const n = c.match(/[\d.]+/g)!.map(Number)
      return { r: n[0]!, g: n[1]!, b: n[2]!, a: n[3] ?? 1 }
    }
    const over = (f: ReturnType<typeof parse>, b: ReturnType<typeof parse>) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 })
    const lum = ({ r, g, b }: ReturnType<typeof parse>) =>
      [r, g, b].map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i]!, 0)
    const body = parse(getComputedStyle(document.body).backgroundColor)
    const pageBg = over(parse(getComputedStyle(document.querySelector('.slate-scroll')!).backgroundColor), body)
    const fg = lum(parse(getComputedStyle(document.querySelector(sel)!).color))
    const bg = lum(pageBg)
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
  }, selector)
}

test('Settings → Appearance shows the built-in themes, Dark active', async ({ page }) => {
  await openAppearance(page)
  for (const id of ['dark', 'light', 'glass', 'paper', 'solarized-light', 'nord']) await expect(card(page, `builtin:${id}`)).toBeVisible()
  await expect(card(page, 'builtin:dark')).toHaveAttribute('data-active', 'true')
})

test('choosing Light changes --bg and survives a restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  try {
    expect(await rootVar(first.page, '--bg')).toBe('#1e1e1eff')
    await openAppearance(first.page)
    await card(first.page, 'builtin:light').click()
    await expect.poll(() => rootVar(first.page, '--bg')).toBe('#ffffffff')
    await expect(first.page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  } finally {
    await first.app.close()
  }
  const second = await launchApp(userData)
  try {
    expect(await rootVar(second.page, '--bg')).toBe('#ffffffff')
  } finally {
    await second.app.close()
  }
})

test('Paper sets the paper texture; Glass sets glass and keeps body text at 4.5:1', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await createBoxAt(page, 200, 160)
  await page.keyboard.type('Readable on glass')
  await openAppearance(page)
  await card(page, 'builtin:paper').click()
  await expect.poll(() => rootAttr(page, 'data-texture')).toBe('paper')
  expect(await rootVar(page, '--texture-image')).toContain('data:image/png')
  await card(page, 'builtin:glass').click()
  await expect.poll(() => rootAttr(page, 'data-material')).toBe('glass')
  expect(await rootAttr(page, 'data-texture')).toBe('none')
  expect(await textContrast(page, '.slate-box-content')).toBeGreaterThanOrEqual(4.5)
})

test('Animations Off sets reduced motion and the effects canvas stops drawing', async ({ page }) => {
  await openAppearance(page)
  await card(page, 'builtin:glass').click()
  await page.getByTestId('setting-motion').selectOption('full')
  await expect.poll(() => rootAttr(page, 'data-motion')).toBe('full')
  const canvas = page.getByTestId('theme-effects')
  await expect(canvas).toHaveAttribute('data-frames', /\d+/)
  await page.getByTestId('setting-motion').selectOption('reduced')
  await expect.poll(() => rootAttr(page, 'data-motion')).toBe('reduced')
  const before = await canvas.getAttribute('data-frames')
  await page.waitForTimeout(500)
  expect(await canvas.getAttribute('data-frames')).toBe(before)
})

test('a theme generated with (fake) Claude is previewed, then saved to the grid', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_CLAUDE_THEME: '1' })
  try {
    await openAppearance(page)
    await page.getByTestId('theme-describe').fill('calm forest green, low contrast borders')
    await page.getByTestId('theme-generate').click()
    await expect(page.getByTestId('theme-preview-name')).toContainText('Calm Forest')
    await expect.poll(() => rootVar(page, '--bg')).toBe('#16241cff')
    await page.getByTestId('theme-preview-save').click()
    const saved = page.getByTestId('theme-card').filter({ hasText: 'Calm Forest' })
    await expect(saved).toBeVisible()
    await expect(saved).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('Escape')
    await expect.poll(() => rootVar(page, '--bg')).toBe('#16241cff')
  } finally {
    await app.close()
  }
})

test('imported black text is readable in Dark and stays black in Paper', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'slate-e2e-colors-'))
  const backupDir = join(scratch, 'Notes Fixture Book')
  mkdirSync(backupDir)
  copyFileSync(join(__dirname, '../../importer/test/fixtures/one/New Section 1.one'), join(backupDir, 'New Section 1 (On 27-10-2020).one'))
  const converter = writeFakeConverter(scratch, join(__dirname, '../../importer/test/fixtures/one2html-colors'))
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_ONE2HTML: converter, SLATE_E2E_BACKUP_PATH: backupDir })
  try {
    await clickMenu(app, 'import-onenote-backup')
    const dialog = page.getByTestId('import-dialog')
    await expect(dialog.getByTestId('backup-picker')).toBeVisible()
    await dialog.getByTestId('import-start').click()
    await expect(dialog.getByTestId('import-report')).toBeVisible({ timeout: 20_000 })
    await dialog.getByTestId('import-done').click()
    await page.getByTestId('notebook-picker').click()
    await page.getByRole('menuitem', { name: 'Fixture Book' }).click()
    await page.getByTestId('section-item').filter({ hasText: 'New Section 1' }).click()
    await page.getByTestId('page-item').filter({ hasText: 'Test Page' }).click()
    const black = page.locator('span[data-color]', { hasText: 'DB restore' }).first()
    await expect(black).toBeVisible()
    await black.evaluate((el) => el.setAttribute('data-sample', ''))
    expect(await textContrast(page, '[data-sample]')).toBeGreaterThanOrEqual(3)

    await page.evaluate(() => window.slate.settings.set({ themeId: 'builtin:paper' }))
    await expect.poll(() => rootAttr(page, 'data-texture')).toBe('paper')
    await expect(page.locator('span[data-color]', { hasText: 'DB restore' }).first()).toHaveCSS('color', 'rgb(0, 0, 0)')
  } finally {
    await app.close()
  }
})
