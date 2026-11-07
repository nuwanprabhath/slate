import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { LoroDoc } from 'loro-crdt'
import { createBoxAt, expect, launchApp, test, unlockWith } from './fixtures'
import { connectMcp, textOf } from './mcpClient'

const root = mkdtempSync(join(tmpdir(), 'slate-e2e-encrypt-'))
const bare = join(root, 'notes.git')
const remoteUrl = `file://${bare}`
const aData = join(root, 'a')
const bData = join(root, 'b')
const MARKER = 'PLAINTEXT-MARKER-E5-9d2c'
// C5: `SLATE_TEST_PROFILE=fips-140-3` runs the whole flow on a FIPS 140-3 vault (npm run e2e:fips -w @slate/desktop).
const PROFILE = process.env.SLATE_TEST_PROFILE === 'fips-140-3' ? 'fips-140-3' : 'standard'
const PASSWORD = 'e2e encryption password'
const NEW_PASSWORD = 'a changed e2e password'
const apps: ElectronApplication[] = []
let a: Page
let b: Page
let bApp: ElectronApplication

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchApp(userData, { SLATE_SYNC_INTERVAL_MS: '500', SLATE_TEST_WEAK_KDF: '1' })
  apps.push(launched.app)
  return launched
}

async function close(app: ElectronApplication): Promise<void> {
  apps.splice(apps.indexOf(app), 1)
  await app.close()
}

async function configureGit(page: Page) {
  await page.getByTestId('sync-menu').click()
  await page.getByTestId('sync-settings-open').click()
  await expect(page.getByTestId('sync-settings')).toBeVisible()
  await page.getByTestId('sync-provider-git').check()
  await page.getByTestId('git-remote-url').fill(remoteUrl)
  await page.getByTestId('sync-settings-save').click()
  // Save waits for a first sync (clone, vault check, push): seconds of git processes on a loaded machine.
  await expect(page.getByTestId('sync-settings')).toHaveCount(0, { timeout: 30_000 })
}

async function openSecurity(page: Page) {
  await page.getByTestId('activity-settings').click()
  await page.locator('.settings-nav-item', { hasText: 'Security' }).click()
  await expect(page.getByTestId('settings-heading')).toHaveText('Security')
}

/** Syncs run back to back at the test interval, so "synced" is brief: an observer sees it where polling can miss it. */
const synced = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const button = document.querySelector('[data-testid="sync-status"]')!
        const done = () => button.getAttribute('data-state') === 'idle-synced' && resolve()
        if (done()) return
        const observer = new MutationObserver(() => done() && observer.disconnect())
        observer.observe(button, { attributes: true, attributeFilter: ['data-state'] })
        setTimeout(() => reject(new Error(`never synced: ${button.getAttribute('title')}`)), 30_000)
      }),
  )

/** Every object reachable from the branch: its path (empty for a commit) and its bytes as git prints them, decompressed. */
function reachableObjects(): Array<{ path: string; bytes: Buffer }> {
  return execFileSync('git', ['--git-dir', bare, 'rev-list', '--objects', 'main'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => {
      const [sha, path = ''] = l.split(' ')
      return { path, bytes: execFileSync('git', ['--git-dir', bare, 'cat-file', '-p', sha!]) }
    })
}

const isLoro = (bytes: Buffer): boolean => bytes.subarray(0, 4).toString('latin1') === 'loro'

/** The paths of reachable objects that are plaintext Loro documents (they start with Loro's magic). */
function loroObjects(): string[] {
  return reachableObjects()
    .filter((o) => isLoro(o.bytes))
    .map((o) => o.path)
}

/**
 * Every reachable object's bytes, followed by what each plaintext Loro document among them says: its content now
 * and its history. Loro does not promise typed text is one run of bytes (1.17 stores text typed a key at a time in
 * pieces), so a byte search alone could miss a plaintext note and pass the "no plaintext" checks below for the
 * wrong reason. Every blob with Loro's magic is decoded, wherever it is stored; a document's chunks under
 * `docs/<id>/` together, since each builds on the ones before it. History that cannot be applied (a chunk missing)
 * fails the test rather than leaving text undecoded.
 */
function reachableContents(): string {
  const objects = reachableObjects()
  const groups = new Map<string, Buffer[]>()
  for (const { path, bytes } of objects) {
    if (!isLoro(bytes)) continue
    const key = /^docs\/([^/]+)\//.exec(path)?.[1] ?? path
    groups.set(key, [...(groups.get(key) ?? []), bytes])
  }
  const decoded = [...groups].map(([key, chunks]) => {
    const doc = new LoroDoc()
    if (doc.importBatch(chunks).pending !== null) throw new Error(`${key}: Loro history with changes missing on the remote`)
    return `${JSON.stringify(doc.toJSON())}\n${JSON.stringify(doc.exportJsonUpdates())}`
  })
  return [...objects.map((o) => o.bytes.toString('latin1')), ...decoded].join('\n')
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

/** Unlocks on the lock screen `page` of `app` and returns the notes window that replaces it (Z-6). */
async function unlock(app: ElectronApplication, page: Page, password: string): Promise<Page> {
  return unlockWith(app, page, password)
}

test.describe.serial('Encrypt my notes with git sync', () => {
  test.beforeAll(() => {
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
  })

  test.afterAll(async () => {
    for (const app of apps.splice(0)) await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  test('device A encrypts its synced notes through the wizard', async () => {
    test.setTimeout(120_000)
    const launched = await launch(aData)
    a = launched.page
    await expect(a.getByTestId('canvas')).toBeVisible()
    await createBoxAt(a, 200, 150)
    await a.keyboard.type(MARKER)
    await configureGit(a)
    await expect.poll(() => reachableContents().includes(MARKER), { timeout: 30_000 }).toBe(true)

    await openSecurity(a)
    await expect(a.getByTestId('security-status')).toHaveText('Your notes are not encrypted.')
    await a.getByTestId('security-encrypt').click()
    const wizard = a.getByTestId('encrypt-wizard')
    await expect(wizard).toContainText('your notes are gone')
    await a.getByTestId('wizard-next').click()
    await expect(wizard).toContainText('Update your other devices first')
    await a.getByTestId('wizard-next').click()
    // The profile choice is offered because this build runs the FIPS module (docs/compliance/decisions.md).
    await expect(a.getByTestId('wizard-profile')).toBeVisible()
    if (PROFILE === 'fips-140-3') await a.getByTestId('wizard-profile-fips').check()
    await a.getByTestId('wizard-password').fill('short')
    await expect(a.getByTestId('wizard-password-strength')).toContainText(PROFILE === 'fips-140-3' ? '15' : '10')
    await a.getByTestId('wizard-password').fill(PASSWORD)
    await a.getByTestId('wizard-password-again').fill(PASSWORD)
    await expect(a.getByTestId('wizard-next')).toBeEnabled()
    await a.getByTestId('wizard-next').click()
    const key = a.getByTestId('recovery-key')
    // This step creates the vault (KDF, key wraps, header) before the key shows: seconds on a loaded machine.
    await expect(key.locator('span')).toHaveCount(14, { timeout: 30_000 })
    const recoveryKey = (await key.locator('span').allTextContents()).join('-')
    await a.getByTestId('wizard-next').click()
    await a.getByTestId('recovery-confirm-input').fill('0000-1111')
    await a.getByTestId('wizard-next').click()
    await expect(a.getByTestId('wizard-error')).toContainText('not the recovery key')
    await a.getByTestId('recovery-confirm-input').fill(recoveryKey.toLowerCase())
    await a.getByTestId('wizard-next').click()
    await expect(wizard).toContainText('Replace your sync folder')
    await expect(a.getByTestId('wizard-next')).toBeDisabled()
    await a.getByTestId('wipe-confirm').check()
    await a.getByTestId('wizard-next').click()
    await expect(a.getByTestId('wizard-progress')).toBeVisible()
    // The window reloads into the encrypted notes.
    await expect(wizard).toHaveCount(0, { timeout: 60_000 })
    await expect(a.getByTestId('box').first()).toContainText(MARKER, { timeout: 15_000 })
    await synced(a)
    expect(existsSync(join(aData, 'slate.db'))).toBe(false)
    expect(existsSync(join(aData, 'local-keys.json'))).toBe(true)
    // C5 criterion 3: a new vault is suite 0x02, in the chosen profile; PQ-B4 (T-PQ-B4-03): header v3, since every device
    // record on the remote is this build's (pq 1).
    const header = JSON.parse(readFileSync(join(aData, 'vault.json'), 'utf8')) as { version: number; suite: number; profile: string; kdf: { alg: string } }
    expect(header).toMatchObject({ version: 3, suite: 2, profile: PROFILE, pq: { kem: 'hybrid-only', minCapability: 1 } })
    expect(header.kdf.alg).toBe(PROFILE === 'fips-140-3' ? 'pbkdf2-hmac-sha512' : 'argon2id')
    await openSecurity(a)
    await expect(a.getByTestId('security-profile')).toContainText(PROFILE === 'fips-140-3' ? 'FIPS 140-3' : 'Standard')

    // AI access goes through the app once the notes are encrypted, without a restart.
    const mcp = await connectMcp(aData)
    try {
      await expect.poll(async () => textOf(await mcp.client.callTool({ name: 'list_tree', arguments: {} })), { timeout: 15_000 }).not.toContain('is locked')
    } finally {
      await mcp.close()
    }
  })

  test('the remote holds no plaintext in anything reachable from the branch', async () => {
    const contents = reachableContents()
    expect(contents).toContain('e2ee')
    expect(contents).not.toContain(MARKER)
    // Nothing on the remote is a plaintext Loro document, whatever its path or however its text is laid out.
    expect(loroObjects()).toEqual([])
    // Suite 0x02 names (audit §4.6): 64 hex characters, SIV ‖ CTR.
    expect(contents).toMatch(/\b[0-9a-f]{64}\.c\b/)
    expect(execFileSync('git', ['--git-dir', bare, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim()).not.toBe('0')
  })

  test('after a relaunch A unlocks with the password and the notes are intact', async () => {
    test.setTimeout(60_000)
    await close(apps[0]!)
    const launched = await launch(aData)
    await expect(launched.page.getByTestId('lock-screen')).toBeVisible()
    a = await unlock(launched.app, launched.page, PASSWORD)
    await expect(a.getByTestId('box').first()).toContainText(MARKER, { timeout: 15_000 })
  })

  test('plaintext device B on the same remote is asked to join, and then sees A’s notes', async () => {
    test.setTimeout(120_000)
    const launched = await launch(bData)
    b = launched.page
    bApp = launched.app
    await expect(b.getByTestId('canvas')).toBeVisible()
    await configureGit(b)
    await expect(b.getByTestId('vault-join-banner')).toContainText('Your notes are now encrypted on another device', { timeout: 30_000 })
    await b.getByTestId('vault-join-open').click()
    await b.getByTestId('vault-join-password').fill('not the password')
    await b.getByTestId('vault-join-submit').click()
    await expect(b.getByTestId('vault-join-error')).toHaveText("That password didn't work")
    await b.getByTestId('vault-join-password').fill(PASSWORD)
    await b.getByTestId('vault-join-submit').click()
    await expect(b.getByTestId('canvas')).toContainText(MARKER, { timeout: 60_000 })
    await expect(b.getByTestId('vault-join-banner')).toHaveCount(0)
    expect(existsSync(join(bData, 'slate.db'))).toBe(false)
    expect(reachableContents()).not.toContain(MARKER)
    expect(loroObjects()).toEqual([])
  })

  test('A changes its password; B unlocks with the new one after a sync', async () => {
    test.setTimeout(120_000)
    await openSecurity(a)
    await a.getByTestId('security-current').fill(PASSWORD)
    await a.getByTestId('security-new').fill(NEW_PASSWORD)
    await a.getByTestId('security-new-again').fill(NEW_PASSWORD)
    await a.getByTestId('security-change-submit').click()
    await expect(a.getByTestId('security-change-message')).toHaveText('Password changed.', { timeout: 30_000 })
    await expect.poll(() => existsSync(join(bData, 'vault.pending.json')), { timeout: 30_000 }).toBe(true)
    await b.evaluate(() => window.slate.vault.lock())
    const locked = await lockWindow(bApp)
    const unlocked = await unlock(bApp, locked, NEW_PASSWORD)
    await expect(unlocked.getByTestId('canvas')).toContainText(MARKER, { timeout: 15_000 })
  })
})
