// GDPR-03, -06, -11: sync asks before it sends anything, names no person on the remote, and forgets a connection.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp, test } from './fixtures'

const root = mkdtempSync(join(tmpdir(), 'slate-e2e-sync-privacy-'))
const apps: ElectronApplication[] = []

test.afterAll(async () => {
  for (const app of apps.splice(0)) await app.close()
  rmSync(root, { recursive: true, force: true })
})

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; data: string }> {
  const data = join(root, name)
  const launched = await launchApp(data, { SLATE_SYNC_INTERVAL_MS: '500' })
  apps.push(launched.app)
  await expect(launched.page.getByTestId('canvas')).toBeVisible()
  return { ...launched, data }
}

function bareRepo(name: string): string {
  const bare = join(root, `${name}.git`)
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare])
  return bare
}

const inBare = (bare: string, ...args: string[]) => execFileSync('git', ['--git-dir', bare, ...args]).toString().trim()
const hasHead = (bare: string) => {
  try {
    inBare(bare, 'rev-parse', '--verify', '--quiet', 'main')
    return true
  } catch {
    return false
  }
}

async function openSync(page: Page): Promise<void> {
  await page.getByTestId('sync-menu').click()
  await page.getByTestId('sync-settings-open').click()
  await expect(page.getByTestId('sync-settings')).toBeVisible()
}

async function chooseGit(page: Page, bare: string): Promise<void> {
  await openSync(page)
  await page.getByTestId('sync-provider-git').check()
  await page.getByTestId('git-remote-url').fill(`file://${bare}`)
  await page.getByTestId('sync-settings-save').click()
}

const dialog = (page: Page) => page.getByTestId('consent-dialog')
const settings = (page: Page) => page.evaluate(() => window.slate.settings.get())

test('declining either consent step saves nothing and contacts no remote', async () => {
  const { page } = await launch('declined')
  const bare = bareRepo('declined')
  await chooseGit(page, bare)
  await expect(dialog(page)).toContainText('Sync your notes with a git repository')
  await dialog(page).getByRole('button', { name: 'Not now' }).click()
  await expect(page.getByTestId('sync-check')).toHaveText('Sync stays off until you allow it.')
  expect((await settings(page)).syncProvider).toBeNull()

  await page.getByTestId('sync-settings-save').click()
  await dialog(page).getByRole('button', { name: 'Allow' }).click()
  await expect(dialog(page)).toContainText('Sync without encryption')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByTestId('sync-check')).toHaveText('Sync stays off until you allow it.')
  expect((await settings(page)).syncProvider).toBeNull()
  expect((await page.evaluate(() => window.slate.privacy.status())).allowed).toMatchObject({ gitSync: true, plaintextSync: false })
  expect(hasHead(bare)).toBe(false)
})

test('Encrypt my notes first is the main action of the unencrypted step, and opens the encryption wizard instead', async () => {
  const { page } = await launch('encrypt-first')
  const bare = bareRepo('encrypt-first')
  await page.evaluate(() => window.slate.privacy.grant('gitSync'))
  await chooseGit(page, bare)
  const encrypt = dialog(page).getByRole('button', { name: 'Encrypt my notes first' })
  await expect(encrypt).toHaveClass(/primary/)
  await encrypt.click()
  await expect(page.getByTestId('encrypt-wizard')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByTestId('sync-settings')).toHaveCount(0)
  expect((await settings(page)).syncProvider).toBeNull()
  expect(hasHead(bare)).toBe(false)
})

test.describe.serial('a consented plaintext connection', () => {
  let page: Page
  let data: string
  let bare: string

  test('allowing both steps syncs under a pseudonymous identity', async () => {
    test.setTimeout(90_000)
    ;({ page, data } = await launch('allowed'))
    bare = bareRepo('allowed')
    await chooseGit(page, bare)
    await dialog(page).getByRole('button', { name: 'Allow' }).click()
    await expect(dialog(page)).toContainText('Sync without encryption')
    await dialog(page).getByRole('button', { name: 'Allow' }).click()
    await expect(page.getByTestId('sync-settings')).toHaveCount(0, { timeout: 45_000 })
    await expect.poll(() => hasHead(bare), { timeout: 30_000 }).toBe(true)
    expect(new Set(inBare(bare, 'log', '--format=%an|%ae|%cn|%ce', 'main').split('\n'))).toEqual(new Set(['Slate|slate@invalid|Slate|slate@invalid']))
    for (const subject of inBare(bare, 'log', '--format=%s', 'main').split('\n')) expect(['slate: sync', 'slate: initialise']).toContain(subject)
    const deviceId = (await settings(page)).deviceId!
    expect(JSON.parse(inBare(bare, 'show', `main:devices/${deviceId}.json`)).name).toBe(`Device ${deviceId.slice(0, 8)}`)
  })

  test('withdrawing the consent pauses sync at its next run', async () => {
    await page.evaluate(() => window.slate.privacy.revoke('plaintextSync'))
    await expect(page.getByTestId('notice')).toContainText('Sync paused: consent withdrawn', { timeout: 20_000 })
    await expect.poll(async () => (await page.evaluate(() => window.slate.sync.status())).status, { timeout: 10_000 }).toBe('disabled')
    expect((await settings(page)).syncProvider).toBe('git')
    await page.evaluate(() => window.slate.privacy.grant('plaintextSync'))
  })

  test('Turn off and forget this connection removes its clone and turns sync off', async () => {
    test.setTimeout(60_000)
    const gitDir = join(data, 'git-sync')
    await expect.poll(() => (existsSync(gitDir) ? readdirSync(gitDir).filter((f) => !f.endsWith('.bin')).length : 0)).toBeGreaterThan(0)
    await openSync(page)
    await page.getByTestId('sync-provider-off').check()
    await expect(page.getByTestId('sync-settings-save')).toHaveText('Turn off')
    await page.getByTestId('sync-forget').click()
    // An error shows in the dialog's check line, which then names the failure here.
    const outcome = async () => ((await page.getByTestId('sync-check').count()) > 0 ? await page.getByTestId('sync-check').textContent() : (await page.getByTestId('sync-settings').count()) > 0 ? 'open' : 'closed')
    await expect.poll(outcome, { timeout: 30_000 }).toBe('closed')
    expect(await settings(page)).toMatchObject({ syncProvider: null, git: null })
    expect(readdirSync(gitDir).filter((f) => !f.endsWith('.bin'))).toEqual([])
    expect(await page.evaluate(() => window.slate.sync.gitAuthInfo())).toMatchObject({ hasToken: false, hasDeviceToken: false })
  })
})

test('the GitHub sign-in names the "repo" permission before it starts, and a token is advised for one repository', async () => {
  const { app, page } = await launch('scope')
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('sync:git-auth-info')
    ipcMain.handle('sync:git-auth-info', () => ({ deviceFlow: true, hasToken: false, hasDeviceToken: false }))
  })
  await openSync(page)
  await page.getByTestId('sync-provider-git').check()
  await page.getByTestId('git-auth-device').check()
  await expect(page.getByTestId('git-device-scope')).toContainText('"repo" permission')
  await expect(page.getByTestId('git-device-scope')).toContainText('every repository')
  await page.getByTestId('git-auth-token').check()
  await expect(page.getByTestId('git-token-help')).toContainText('fine-grained token')
  await expect(page.getByTestId('git-token')).toHaveAttribute('aria-describedby', 'git-token-help')
  await expect(page.getByTestId('sync-pseudonymous')).toBeVisible()
})
