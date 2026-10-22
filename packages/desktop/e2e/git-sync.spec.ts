import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt,expect, launchApp, test } from './fixtures'

const root = mkdtempSync(join(tmpdir(), 'slate-e2e-git-'))
const bare = join(root, 'notes.git')
const remoteUrl = `file://${bare}`
const aData = join(root, 'a')
const bData = join(root, 'b')
const apps: ElectronApplication[] = []
let a: Page
let b: Page

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchApp(userData, { SLATE_SYNC_INTERVAL_MS: '500' })
  apps.push(launched.app)
  return launched
}

async function openSettings(page: Page) {
  await page.getByTestId('sync-menu').click()
  await page.getByTestId('sync-settings-open').click()
  await expect(page.getByTestId('settings-heading')).toHaveText('Sync')
  await expect(page.getByTestId('sync-settings')).toBeVisible()
}

async function configureGit(page: Page) {
  await openSettings(page)
  await page.getByTestId('sync-provider-git').check()
  await page.getByTestId('git-remote-url').fill(remoteUrl)
  await expect(page.getByTestId('git-auth-system')).toBeChecked()
  await page.getByTestId('git-test').click()
  await expect(page.getByTestId('sync-check')).toContainText('Connected')
  await page.getByTestId('sync-settings-save').click()
  await expect(page.getByTestId('sync-settings')).toHaveCount(0)
}

/**
 * Resolves once the status button's tooltip says it synced to git. Syncs run back to back at the
 * test interval, so "synced" is brief; an observer sees it where polling can miss it.
 */
const syncedToGit = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const button = document.querySelector('[data-testid="sync-status"]')!
        const done = () => /Synced to your git repository/.test(button.getAttribute('title') ?? '') && resolve(button.getAttribute('title')!)
        if (done()) return
        const observer = new MutationObserver(() => done() && observer.disconnect())
        observer.observe(button, { attributes: true, attributeFilter: ['title'] })
        setTimeout(() => reject(new Error(`never synced: ${button.getAttribute('title')}`)), 20_000)
      }),
  )

test('with sync off the toolbar button opens Sync settings, at the toolbar right edge', async () => {
  const { app, page } = await launch(join(root, 'off'))
  try {
    const button = page.getByTestId('sync-status')
    await expect(button).toBeVisible()
    const toolbar = (await page.getByRole('toolbar', { name: 'Formatting' }).boundingBox())!
    const box = (await page.getByTestId('sync-menu').boundingBox())!
    expect(box.x + box.width).toBeGreaterThan(toolbar.x + toolbar.width - 24)
    expect(box.x + box.width).toBeLessThanOrEqual(toolbar.x + toolbar.width)
    await button.click()
    await expect(page.getByTestId('sync-settings')).toBeVisible()
  } finally {
    await app.close()
    apps.splice(apps.length - 1, 1)
  }
})

test.describe.serial('git sync between two devices', () => {
  test.beforeAll(async () => {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare])
    a = (await launch(aData)).page
    b = (await launch(bData)).page
    await configureGit(a)
    await configureGit(b)
  })

  test.afterAll(async () => {
    for (const app of apps.splice(0)) await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  test('an edit on A appears on B', async () => {
    test.setTimeout(60_000)
    await createBoxAt(a, 200, 150)
    await expect(a.locator('[data-testid="box-editor"]:focus')).toHaveText('')
    await a.keyboard.type('hello over git')

    await b.getByTestId('notebook-picker').click()
    const other = b.locator('.notebook-menu > [role="menuitem"]:not(.selected):has(~ hr)')
    await expect(other).toHaveCount(1, { timeout: 15_000 })
    await other.click()
    await expect(b.getByTestId('canvas')).toContainText('hello over git', { timeout: 15_000 })
    expect(await syncedToGit(a)).toContain('Last synced just now')
  })

  test('settings saved in the overlay survive a relaunch', async () => {
    await apps.shift()!.close()
    a = (await launch(aData)).page
    await openSettings(a)
    await expect(a.getByTestId('sync-provider-git')).toBeChecked()
    await expect(a.getByTestId('git-remote-url')).toHaveValue(remoteUrl)
    await expect(a.getByTestId('git-branch')).toHaveValue('main')
    await expect(a.getByTestId('git-auth-system')).toBeChecked()
    await a.keyboard.press('Escape')
    await expect(a.getByTestId('sync-settings')).toHaveCount(0)
    await syncedToGit(a)
  })

  test('clicking the toolbar button runs a sync', async () => {
    const button = a.getByTestId('sync-status')
    await expect(button).toHaveAttribute('data-state', 'idle-synced', { timeout: 20_000 })
    await expect(a.getByTestId('sync-age')).toHaveText(/just now|min ago/)
    await button.click()
    await expect(button).toHaveAttribute('data-state', 'idle-synced', { timeout: 20_000 })
    await expect(button).toHaveAttribute('title', /Last synced just now/)
  })

  test('the repository has commits from both devices and no credentials anywhere', async () => {
    const emails = execFileSync('git', ['--git-dir', bare, 'log', '--format=%ae', 'main']).toString().trim().split('\n')
    expect(new Set(emails.filter((e) => e.startsWith('slate@'))).size).toBe(2)
    const configs = [join(bare, 'config')]
    for (const data of [aData, bData]) {
      const dir = join(data, 'git-sync')
      for (const clone of readdirSync(dir)) {
        const config = join(dir, clone, '.git', 'config')
        if (existsSync(config)) configs.push(config)
      }
    }
    expect(configs.length).toBe(3)
    for (const config of configs) expect(readFileSync(config, 'utf8')).not.toMatch(/extraheader|token|AUTHORIZATION/i)
  })
})
