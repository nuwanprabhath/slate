import { mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFakeConverter } from '../../importer/test/fakeOne2html'
import { expect, launchApp, test } from './fixtures'

const FIXTURE = join(__dirname, '../../importer/test/fixtures/one/New Section 1.one')
const COLORS_OUTPUT = join(__dirname, '../../importer/test/fixtures/one2html-colors')

test('imported black text is readable on the dark theme and red stays red', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'slate-e2e-colors-'))
  const backupDir = join(scratch, 'Notes Fixture Book')
  mkdirSync(backupDir)
  copyFileSync(FIXTURE, join(backupDir, 'New Section 1 (On 27-10-2020).one'))
  const converter = writeFakeConverter(scratch, COLORS_OUTPUT)
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, { SLATE_ONE2HTML: converter, SLATE_E2E_BACKUP_PATH: backupDir })
  try {
    await page.emulateMedia({ colorScheme: 'dark' })
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('import-onenote-backup')!.click())
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
    const red = page.locator('span[data-color]', { hasText: 'red warning' }).first()
    await expect(black).toBeVisible()

    const result = await black.evaluate((el) => {
      const parse = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      const lum = ([r, g, b]: number[]) =>
        [r!, g!, b!]
          .map((v) => v / 255)
          .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
      const fg = lum(parse(getComputedStyle(el).color))
      const bg = lum(parse(getComputedStyle(document.body).backgroundColor))
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
    })
    expect(result).toBeGreaterThanOrEqual(3)
    await expect(red).toHaveCSS('color', 'rgb(255, 0, 0)')
  } finally {
    await app.close()
  }
})
