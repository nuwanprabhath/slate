import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { startFakeDrive, type FakeDrive } from '../../sync/test/fakeDrive'
import { expect, launchApp, test } from './fixtures'

const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'

let drive: FakeDrive
const apps: ElectronApplication[] = []
let a: Page
let b: Page

async function launch(): Promise<Page> {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-sync-')), {
    SLATE_GRAPH_URL: drive.url,
    SLATE_FAKE_AUTH: '1',
    SLATE_SYNC_INTERVAL_MS: '500',
  })
  apps.push(app)
  return page
}

async function turnOnSync(page: Page) {
  await page.getByTestId('sync-status').click()
  await expect(page.getByTestId('sync-popover')).toBeVisible()
  await page.getByTestId('sync-toggle').click()
  await expect(page.getByTestId('sync-toggle')).toHaveText('Turn off sync')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('sync-popover')).toHaveCount(0)
}

const status = (page: Page) => page.getByTestId('sync-status')

test.describe.serial('OneDrive sync between two devices', () => {
  test.beforeAll(async () => {
    drive = await startFakeDrive()
    a = await launch()
    b = await launch()
    await turnOnSync(a)
    await turnOnSync(b)
  })

  test.afterAll(async () => {
    for (const app of apps) await app.close()
    await drive.close()
  })

  test('an edit on A appears live on B', async () => {
    await a.getByTestId('canvas').click({ position: { x: 200, y: 150 } })
    // Wait for the NEW (empty) box to own focus before typing.
    await expect(a.locator('[data-testid="box-editor"]:focus')).toHaveText('')
    await a.keyboard.type('hello from A')

    // A's notebook arrives on B as a second notebook; open it.
    await b.getByTestId('notebook-picker').click()
    // Notebooks are the menu items above its first divider.
    const other = b.locator('.notebook-menu > [role="menuitem"]:not(.selected):has(~ hr)')
    await expect(other).toHaveCount(1, { timeout: 10_000 })
    await other.click()
    await expect(b.getByTestId('canvas')).toContainText('hello from A', { timeout: 10_000 })

    await a.keyboard.type(' and more')
    await expect(b.getByTestId('canvas')).toContainText('hello from A and more', { timeout: 10_000 })
  })

  test('both devices show synced', async () => {
    await expect(status(a)).toHaveAttribute('data-state', 'idle-synced', { timeout: 10_000 })
    await expect(status(b)).toHaveAttribute('data-state', 'idle-synced', { timeout: 10_000 })
  })

  test('losing the drive shows offline, and getting it back shows synced', async () => {
    drive.offline(true)
    await expect(status(a)).toHaveAttribute('data-state', 'offline', { timeout: 5_000 })
    drive.offline(false)
    await expect(status(a)).toHaveAttribute('data-state', 'idle-synced', { timeout: 5_000 })
  })

  test('offline edits to the same box are merged and can be resolved', async () => {
    test.setTimeout(60_000)
    await expect(status(a)).toHaveAttribute('data-state', 'idle-synced', { timeout: 10_000 })
    await expect(status(b)).toHaveAttribute('data-state', 'idle-synced', { timeout: 10_000 })
    drive.offline(true)
    await expect(status(a)).toHaveAttribute('data-state', 'offline', { timeout: 5_000 })
    await expect(status(b)).toHaveAttribute('data-state', 'offline', { timeout: 5_000 })

    for (const [page, text] of [
      [a, ' edit-on-A'],
      [b, ' edit-on-B'],
    ] as const) {
      await page.getByTestId('box-editor').click()
      await page.keyboard.press(LINE_END)
      await page.keyboard.type(text)
      await expect(page.getByTestId('box-editor')).toContainText(text.trim())
    }
    drive.offline(false)

    const chip = (page: Page) => page.getByTestId('conflict-chip')
    await expect.poll(async () => (await chip(a).count()) + (await chip(b).count()), { timeout: 15_000 }).toBeGreaterThan(0)
    const page = (await chip(a).count()) > 0 ? a : b

    await chip(page).click()
    const resolver = page.getByTestId('conflict-resolver')
    await expect(resolver).toContainText('edit-on-A')
    await expect(resolver).toContainText('edit-on-B')
    await page.getByTestId('resolve-mine').click()
    await expect(resolver).toHaveCount(0)
    await expect(chip(page)).toHaveCount(0)

    await expect
      .poll(async () => (await a.getByTestId('box-editor').innerText()) === (await b.getByTestId('box-editor').innerText()), { timeout: 15_000 })
      .toBe(true)
    const mine = page === a ? 'edit-on-A' : 'edit-on-B'
    await expect(a.getByTestId('box-editor')).toContainText(mine)
  })
})
