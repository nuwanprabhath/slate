/**
 * Ways into the states the UI scenarios review that a fresh launch does not show: an encrypted vault
 * (the e2e encrypt hook), and answers main would give only after a real sync, Touch ID or an
 * interrupted migration. Those are stubbed at the IPC door from the test (`app.evaluate` in main):
 * the renderer under review is the real one, asking its real channels; only the answer is canned.
 * Nothing here ships: it lives in e2e/ and runs through Playwright's main-process evaluate.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp, unlockWith } from '../fixtures'

export const PASSWORD = 'e2e ui review password'

/** An encrypted vault, launched locked; returns the lock window. */
export async function lockedApp(): Promise<{ app: ElectronApplication; lock: Page }> {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
  await expect(page.getByTestId('lock-screen')).toBeVisible({ timeout: 30_000 })
  return { app, lock: page }
}

/** An encrypted vault, unlocked; returns the notes window. */
export async function unlockedApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, lock } = await lockedApp()
  const page = await unlockWith(app, lock, PASSWORD)
  await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 30_000 })
  return { app, page }
}

/** Main answers `channel` (a CH value) with `value` from now on, for every window. */
export async function stubInvoke(app: ElectronApplication, channel: string, value: unknown): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel: ch, value: v }) => {
    ipcMain.removeHandler(ch)
    ipcMain.handle(ch, () => v)
  }, { channel, value })
}

/**
 * Main sends `payload` on event `channel` now and in place of every later payload on it, for every open
 * window: the state holds even when main's own code sends the real one afterwards (a settings write makes
 * sync report its status again, and on a slow machine that report can land after a one-off send).
 */
export async function stubEvent(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { channel: ch, payload: p }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      const wc = w.webContents
      const send = wc.send.bind(wc)
      wc.send = (c: string, ...args: unknown[]) => (c === ch ? send(c, p) : send(c, ...args))
      wc.send(ch, p)
    }
  }, { channel, payload })
}

/** Reloads `page` (it asks main for its state again on mount) and waits for `testId`. */
export async function reloadTo(page: Page, testId: string): Promise<void> {
  await page.reload()
  await expect(page.getByTestId(testId).first()).toBeVisible({ timeout: 30_000 })
}
