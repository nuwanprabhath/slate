// C9 (audit §4.7, §7.3 C9 e2e): two devices over a local bare repository. Rotate on A; B unlocks with its password
// and syncs under the new keys. Convert on A to FIPS 140-3; B follows with the new password and reads only suite 0x02.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt, expect, launchApp, test, unlockWith } from './fixtures'

const root = mkdtempSync(join(tmpdir(), 'slate-e2e-rotate-'))
const bare = join(root, 'notes.git')
const remoteUrl = `file://${bare}`
const aData = join(root, 'a')
const bData = join(root, 'b')
const MARKER = 'ROTATION-MARKER-C9-51a7'
const AFTER = 'WRITTEN-AFTER-ROTATION-C9'
const PASSWORD = 'e2e rotation password'
const FIPS_PASSWORD = 'an e2e fips-140-3 passphrase'
const apps: ElectronApplication[] = []
let a: Page
let aApp: ElectronApplication
let b: Page
let bApp: ElectronApplication

async function launch(userData: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchApp(userData, { SLATE_SYNC_INTERVAL_MS: '500', SLATE_TEST_WEAK_KDF: '1', ...extra })
  apps.push(launched.app)
  return launched
}

async function configureGit(page: Page) {
  await page.getByTestId('sync-menu').click()
  await page.getByTestId('sync-settings-open').click()
  await expect(page.getByTestId('sync-settings')).toBeVisible()
  await page.getByTestId('sync-provider-git').check()
  await page.getByTestId('git-remote-url').fill(remoteUrl)
  await page.getByTestId('sync-settings-save').click()
  await expect(page.getByTestId('sync-settings')).toHaveCount(0, { timeout: 30_000 })
}

async function openSecurity(page: Page) {
  await page.getByTestId('activity-settings').click()
  await page.locator('.settings-nav-item', { hasText: 'Security' }).click()
  await expect(page.getByTestId('settings-heading')).toHaveText('Security')
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-heading')).toHaveCount(0)
}

async function lockWindow(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(
      async () => {
        for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return true
        return false
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return w
  throw new Error('no lock window')
}

/** A key change in Settings → Security: password(s), the new recovery key typed back, then the change. */
async function rekey(page: Page, kind: 'rotate' | 'convert', password: string, newPassword?: string) {
  await openSecurity(page)
  await expect(page.getByTestId('security-keys')).toBeVisible()
  await page.getByTestId(`security-${kind}`).click({ timeout: 30_000 })
  await page.getByTestId('security-rekey-password').fill(password)
  if (newPassword) {
    await page.getByTestId('security-rekey-new').fill(newPassword)
    await page.getByTestId('security-rekey-new-again').fill(newPassword)
  }
  await page.getByTestId('security-rekey-continue').click()
  const key = page.getByTestId('security-rekey-recovery-key')
  await expect(key.locator('span')).toHaveCount(14, { timeout: 30_000 })
  const recoveryKey = (await key.locator('span').allTextContents()).join('-')
  await page.getByTestId('security-rekey-confirm').fill(recoveryKey)
  await page.getByTestId('security-rekey-run').click()
}

const header = (dir: string) => JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')) as { keyEpoch: number; profile: string; history?: unknown[] }
const inBare = (...args: string[]) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' })
const remoteHeader = () => JSON.parse(inBare('show', 'main:e2ee/vault.json')) as { keyEpoch: number; profile: string; history?: unknown[] }

/** Every sealed file on the branch: its format (SLE1/SLE2) and, for SLE2, its key epoch. */
function remoteEnvelopes(): Array<{ path: string; format: string; epoch: number | null }> {
  const files = inBare('ls-tree', '-r', '--name-only', 'main').trim().split('\n').filter((f) => /^e2ee\/(d|v|b)\//.test(f))
  return files.map((path) => {
    const bytes = execFileSync('git', ['--git-dir', bare, 'show', `main:${path}`])
    const format = bytes.subarray(0, 4).toString('latin1')
    return { path, format, epoch: format === 'SLE2' ? bytes.readUInt32BE(6) : null }
  })
}

test.describe.serial('C9: key rotation and FIPS conversion across two devices', () => {
  test.beforeAll(() => {
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
  })

  test.afterAll(async () => {
    for (const app of apps.splice(0)) await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  test('A and B share one encrypted vault over git', async () => {
    test.setTimeout(150_000)
    const launchedA = await launch(aData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
    aApp = launchedA.app
    await expect(launchedA.page.getByTestId('lock-screen')).toBeVisible()
    a = await unlockWith(aApp, launchedA.page, PASSWORD)
    await expect(a.getByTestId('canvas')).toBeVisible()
    await createBoxAt(a, 200, 150)
    await a.keyboard.type(MARKER)
    await configureGit(a)
    await expect.poll(() => inBare('ls-tree', '-r', '--name-only', 'main').includes('e2ee/vault.json'), { timeout: 30_000 }).toBe(true)

    const launchedB = await launch(bData)
    bApp = launchedB.app
    b = launchedB.page
    await configureGit(b)
    await expect(b.getByTestId('vault-join-banner')).toBeVisible({ timeout: 30_000 })
    await b.getByTestId('vault-join-open').click()
    await b.getByTestId('vault-join-password').fill(PASSWORD)
    await b.getByTestId('vault-join-submit').click()
    await expect(b.getByTestId('canvas')).toContainText(MARKER, { timeout: 60_000 })
    expect(header(bData).keyEpoch).toBe(0)
  })

  test('rotate on A; B unlocks with its password through the pending header and syncs under epoch 1', async () => {
    test.setTimeout(180_000)
    await rekey(a, 'rotate', PASSWORD)
    // The window reloads into the notes under the new keys.
    await expect.poll(() => header(aData).keyEpoch, { timeout: 60_000 }).toBe(1)
    expect(remoteHeader()).toMatchObject({ keyEpoch: 1 })
    await expect(a.getByTestId('canvas')).toContainText(MARKER, { timeout: 15_000 })

    // B stops syncing under the old keys and asks for the password; unlocking with it follows the rotation.
    await expect(b.getByTestId('vault-join-banner')).toContainText('keys were changed', { timeout: 30_000 })
    expect(existsSync(join(bData, 'vault.candidate.json'))).toBe(true)
    await b.evaluate(() => window.slate.vault.lock())
    b = await unlockWith(bApp, await lockWindow(bApp), PASSWORD)
    await expect(b.getByTestId('canvas')).toContainText(MARKER, { timeout: 30_000 })
    expect(header(bData)).toMatchObject({ keyEpoch: 1 })
    await createBoxAt(b, 260, 320)
    await b.keyboard.type(AFTER)
    await expect(a.getByTestId('canvas')).toContainText(AFTER, { timeout: 60_000 })

    // R-2 on A: re-pushed, old trees swept, history pruned; the branch holds epoch 1 files only.
    await expect.poll(() => existsSync(join(aData, 'migration.json')), { timeout: 90_000 }).toBe(false)
    expect(remoteHeader().history).toBeUndefined()
    await expect.poll(() => remoteEnvelopes().every((f) => f.format === 'SLE2' && f.epoch === 1), { timeout: 30_000 }).toBe(true)
  })

  test('convert on A to FIPS 140-3; B follows with the new password and reads only suite 0x02', async () => {
    test.setTimeout(180_000)
    await rekey(a, 'convert', PASSWORD, FIPS_PASSWORD)
    await expect.poll(() => header(aData).profile, { timeout: 60_000 }).toBe('fips-140-3')
    expect(header(aData)).toMatchObject({ keyEpoch: 2 })
    expect(header(aData).history).toBeUndefined()
    expect(remoteHeader()).toMatchObject({ keyEpoch: 2, profile: 'fips-140-3' })
    await expect(a.getByTestId('canvas')).toContainText(MARKER, { timeout: 15_000 })
    await openSecurity(a)
    await expect(a.getByTestId('security-profile')).toContainText('FIPS 140-3')
    await closeSettings(a)

    await expect(b.getByTestId('vault-join-banner')).toContainText('keys were changed', { timeout: 30_000 })
    await b.getByTestId('vault-join-open').click()
    await b.getByTestId('vault-join-password').fill(PASSWORD)
    await b.getByTestId('vault-join-submit').click()
    await expect(b.getByTestId('vault-join-error')).toHaveText("That password didn't work", { timeout: 30_000 })
    await b.getByTestId('vault-join-password').fill(FIPS_PASSWORD)
    await b.getByTestId('vault-join-submit').click()
    await expect(b.getByTestId('vault-join-banner')).toHaveCount(0, { timeout: 60_000 })
    expect(header(bData)).toMatchObject({ keyEpoch: 2, profile: 'fips-140-3' })
    expect(JSON.parse(readFileSync(join(bData, 'local-keys.json'), 'utf8'))).toMatchObject({ version: 2, profile: 'fips-140-3', keyEpoch: 2 })
    await expect(b.getByTestId('canvas')).toContainText(MARKER, { timeout: 30_000 })

    // Criterion 4: nothing of suite 0x01 or an earlier epoch is left on the branch, and history is empty.
    await expect.poll(() => existsSync(join(aData, 'migration.json')), { timeout: 90_000 }).toBe(false)
    await expect.poll(() => remoteEnvelopes().every((f) => f.format === 'SLE2' && f.epoch === 2), { timeout: 30_000 }).toBe(true)
    expect(remoteHeader().history).toBeUndefined()
  })

  test('R-2: A replaces the sync history; B keeps syncing on a fresh clone', async () => {
    test.setTimeout(120_000)
    await openSecurity(a)
    a.once('dialog', (d) => void d.accept())
    await a.getByTestId('security-replace-history').click({ timeout: 30_000 })
    await expect.poll(() => inBare('rev-list', '--count', 'main').trim(), { timeout: 60_000 }).toBe('1')
    await expect(a.getByTestId('canvas')).toContainText(MARKER, { timeout: 15_000 })
    await createBoxAt(b, 320, 460)
    await b.keyboard.type('AFTER-HISTORY-REPLACED')
    await expect(a.getByTestId('canvas')).toContainText('AFTER-HISTORY-REPLACED', { timeout: 60_000 })
    await expect(b.getByTestId('vault-join-banner')).toHaveCount(0)
  })
})
