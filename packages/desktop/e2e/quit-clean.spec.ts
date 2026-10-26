import { mkdtempSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp, test } from './fixtures'
import { connectMcp, textOf } from './mcpClient'

const PASSWORD = 'e2e quit password'
const LOCKED = 'Slate is locked or not running. Unlock Slate to give AI access.'
const REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')

/** macOS writes `Electron-<date>.ips` for a crashed Electron process, but drops repeats, so the exit status is checked too. */
const crashReports = (): string[] => (process.platform === 'darwin' ? readdirSync(REPORTS).filter((f) => f.startsWith('Electron')) : [])

async function lockScreen(app: ElectronApplication): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(async () => {
      for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) found = w
      return !!found
    }, { timeout: 15_000 })
    .toBe(true)
  return found!
}

async function unlock(page: Page): Promise<void> {
  await page.getByTestId('lock-secret').fill(PASSWORD)
  await page.getByTestId('lock-unlock').click()
}

/** Quits as the user would and resolves with how the process ended. */
async function quit(app: ElectronApplication): Promise<string> {
  const proc = app.process()
  const exited = new Promise<string>((resolve) => proc.once('exit', (code, signal) => resolve(`code ${code} signal ${signal}`)))
  await app.close()
  return exited
}

test('unlock, AI access, lock, unlock and quit ten times, half of them mid-lock, without Electron crashing', async () => {
  test.setTimeout(10 * 30_000)
  const before = new Set(crashReports())
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const exits: string[] = []
  for (let i = 0; i < 10; i++) {
    const { app } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
    const mcp = await connectMcp(userData)
    const listTree = async () => textOf(await mcp.client.callTool({ name: 'list_tree', arguments: {} }))
    try {
      await unlock(await lockScreen(app))
      await expect.poll(listTree, { timeout: 15_000 }).not.toBe(LOCKED)
      await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript('window.slate.vault.lock()'))
      await expect.poll(listTree, { timeout: 15_000 }).toBe(LOCKED)
      // Odd runs quit straight away. The AI socket closes early in the lock, so that quit lands
      // while the lock is still running: the case that crashed. Even runs unlock again first.
      if (i % 2 === 0) {
        await unlock(await lockScreen(app))
        await expect.poll(listTree, { timeout: 15_000 }).not.toBe(LOCKED)
      }
    } finally {
      // slate-mcp stays connected while the app quits.
      exits.push(await quit(app))
      await mcp.close()
    }
  }
  expect(exits).toEqual(Array(10).fill('code 0 signal null'))
  // ReportCrash writes a report a moment after the process dies.
  await new Promise((r) => setTimeout(r, 3000))
  expect(crashReports().filter((f) => !before.has(f))).toEqual([])
})
