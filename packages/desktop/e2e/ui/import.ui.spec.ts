/**
 * The Import from OneNote dialog's two states a person waits in: the list of sections found in the
 * backup they picked, and the progress while it runs. The pick comes from the real dialog (the e2e
 * backup hook answers it), so the list is the real one; only the import itself is stubbed, so the
 * progress state holds still long enough to be looked at.
 */
import { mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test, clickMenu } from '../fixtures'
import { reviewUi } from './review'
import { stubEvent } from './states'

const FIXTURE = join(__dirname, '../../../importer/test/fixtures/one/New Section 1.one')

/** A backup folder the dialog hook returns: one notebook folder with one dated section. */
function backupFolder(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'slate-ui-backup-')), 'Notes Fixture Book')
  mkdirSync(dir)
  copyFileSync(FIXTURE, join(dir, 'New Section 1 (On 27-10-2020).one'))
  return dir
}

test('UI: the import dialog lists the backup’s sections, then shows its progress', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_E2E_BACKUP_PATH: backupFolder() })
  try {
    await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 30_000 })
    const dialog = page.getByTestId('import-dialog')
    const openBackupDialog = async () => {
      if ((await dialog.count()) === 0) await clickMenu(app, 'import-onenote-backup')
      await expect(dialog.getByTestId('backup-picker')).toBeVisible({ timeout: 30_000 })
    }
    await openBackupDialog()
    await reviewUi(app, page, 'import backup pick', { open: openBackupDialog })

    // The import hangs where a real one would be converting, so the progress state stays on screen.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('onenote:start-backup')
      ipcMain.handle('onenote:start-backup', () => new Promise(() => {}))
    })
    await stubEvent(app, 'onenote:progress', {
      phase: 'running',
      sectionsDone: 1,
      sectionsTotal: 3,
      pagesDone: 4,
      pagesTotal: 12,
      currentTitle: 'Weekly plan — Monday’s meeting notes',
      imported: 4,
      skipped: 0,
      failed: [],
      lossy: [],
    })
    await reviewUi(app, page, 'import backup running', {
      open: async (p) => {
        if ((await p.getByTestId('import-running').count()) === 0) await p.getByTestId('import-start').click()
        await expect(p.getByTestId('import-running')).toBeVisible({ timeout: 30_000 })
      },
    })
  } finally {
    await app.close()
  }
})
