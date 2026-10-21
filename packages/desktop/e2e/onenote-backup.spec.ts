import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFakeConverter } from '../../importer/test/fakeOne2html'
import { expect, launchApp, test } from './fixtures'

const FIXTURE = join(__dirname, '../../importer/test/fixtures/one/New Section 1.one')
const CLI = join(__dirname, '..', 'out', 'main', 'import-cli.js')

const scratch = mkdtempSync(join(tmpdir(), 'slate-e2e-backup-'))
const backupDir = join(scratch, 'Notes Fixture Book')
mkdirSync(backupDir)
copyFileSync(FIXTURE, join(backupDir, 'New Section 1 (On 27-10-2020).one'))
// The real converter when SLATE_ONE2HTML is set; otherwise a stand-in that copies the committed output.
const converter = process.env.SLATE_ONE2HTML ?? writeFakeConverter(scratch)

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  // `electron` resolves to the binary's path when required from Node.
  const electronBinary = require('electron') as unknown as string
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env
  const res = spawnSync(electronBinary, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...inherited, ELECTRON_RUN_AS_NODE: '1', SLATE_ONE2HTML: converter },
  })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
}

test('imports a OneNote backup folder through File → Import from OneNote backup', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, { SLATE_ONE2HTML: converter, SLATE_E2E_BACKUP_PATH: backupDir })
  try {
    expect(existsSync(join(userData, 'slate.lock'))).toBe(true)

    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('import-onenote-backup')!.click())
    const dialog = page.getByTestId('import-dialog')
    const picker = dialog.getByTestId('backup-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('checkbox', { name: 'New Section 1' })).toHaveAttribute('aria-checked', 'true')
    await expect(picker).toContainText('backup of 2020-10-27')
    await dialog.getByTestId('import-start').click()
    await expect(dialog.getByTestId('import-report')).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByTestId('import-counts')).toContainText('1 imported')
    await expect(dialog.getByTestId('import-lossy')).toContainText('Ink drawing')
    await dialog.getByTestId('import-done').click()

    await page.getByTestId('notebook-picker').click()
    await page.getByRole('menuitem', { name: 'Fixture Book' }).click()
    await page.getByTestId('section-item').filter({ hasText: 'New Section 1' }).click()
    await expect(page.getByTestId('page-item')).toHaveText(['Test Page'])
    await page.getByTestId('page-item').filter({ hasText: 'Test Page' }).click()
    const boxes = page.getByTestId('box')
    // The title block is the page title; the empty trailing outline makes no box.
    await expect(boxes).toHaveCount(1)
    await expect(boxes.first()).toContainText('Lorem ipsum')
    const img = boxes.locator('img').first()
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)

    // While the app has the folder open, the headless import refuses.
    const refused = runCli(['--backup', backupDir, '--user-data', userData])
    expect(refused.code).toBe(3)
    expect(refused.stderr).toContain('Slate is running')
  } finally {
    await app.close()
  }
  expect(existsSync(join(userData, 'slate.lock'))).toBe(false)
})

test('the built headless import CLI imports into a data folder the app then shows', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const run = runCli(['--backup', backupDir, '--sections', 'New Section 1', '--user-data', userData])
  expect(run.code, run.stderr).toBe(0)
  expect(JSON.parse(run.stdout)).toMatchObject({ phase: 'done', imported: 1, failed: [] })

  const { app, page } = await launchApp(userData)
  try {
    await expect(page.getByTestId('notebook-picker')).toContainText('Fixture Book', { timeout: 15_000 })
    await page.getByTestId('section-item').filter({ hasText: 'New Section 1' }).click()
    await expect(page.getByTestId('page-item')).toHaveText(['Test Page'])
  } finally {
    await app.close()
  }
})
