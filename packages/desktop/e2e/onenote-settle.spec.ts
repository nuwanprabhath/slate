import { mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFakeConverter } from '../../importer/test/fakeOne2html'
import { expect, launchApp, test } from './fixtures'

const FIXTURE = join(__dirname, '../../importer/test/fixtures/one/New Section 1.one')
const OVERLAP_OUTPUT = join(__dirname, '../../importer/test/fixtures/one2html-overlap')

test('an imported page whose boxes overlap once rendered is settled apart', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'slate-e2e-settle-'))
  const backupDir = join(scratch, 'Notes Fixture Book')
  mkdirSync(backupDir)
  copyFileSync(FIXTURE, join(backupDir, 'New Section 1 (On 27-10-2020).one'))
  const converter = writeFakeConverter(scratch, OVERLAP_OUTPUT)
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, { SLATE_ONE2HTML: converter, SLATE_E2E_BACKUP_PATH: backupDir })
  try {
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
    const boxes = page.getByTestId('box')
    await expect(boxes).toHaveCount(3)

    const rects = () =>
      boxes.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          return { text: el.textContent ?? '', x: r.x, y: r.y, right: r.right, bottom: r.bottom }
        }),
      )
    const overlaps = (r: Awaited<ReturnType<typeof rects>>) =>
      r.some((a, i) => r.some((b, j) => i < j && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom))

    await expect.poll(async () => overlaps(await rects()), { timeout: 10_000 }).toBe(false)

    const settled = await rects()
    const first = settled.find((r) => r.text.includes('First box'))!
    const second = settled.find((r) => r.text.includes('Second box'))!
    const side = settled.find((r) => r.text.includes('Side column'))!
    expect(second.y).toBeGreaterThanOrEqual(first.bottom)
    expect(second.x).toBe(first.x)
    expect(side.x).toBeGreaterThan(first.right - 1)
    expect(side.y).toBeLessThan(second.y)
  } finally {
    await app.close()
  }
})
