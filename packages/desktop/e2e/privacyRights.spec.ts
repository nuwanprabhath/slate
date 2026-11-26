import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt, expect, launchApp, MOD, test } from './fixtures'
import type { PrivacyStatus } from '../src/shared/api'
import { CONSENT_FEATURES, DISCLOSURES } from '../src/shared/privacy/consent'

async function openPrivacy(page: Page): Promise<void> {
  await expect(page.getByTestId('canvas')).toBeVisible()
  if (!(await page.getByTestId('settings-dialog').isVisible())) await page.keyboard.press(`${MOD}+,`)
  await page.getByTestId('settings-nav-privacy').click()
  await expect(page.getByTestId('privacy-section')).toBeVisible()
}

async function typeBox(page: Page, text: string): Promise<void> {
  await createBoxAt(page, 120, 80)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
}

/** Main's folder dialog answers `folder` (the test never shows a native dialog). */
async function pickFolder(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    Object.assign(dialog, { showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [f] }) })
  }, folder)
}

const status = (page: Page) => page.evaluate(() => window.slate.privacy.status()) as Promise<PrivacyStatus>

test('Export everything writes a new folder with the page as Markdown and a manifest (GDPR-05)', async ({ app, page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await typeBox(page, 'portable words')
  const parent = mkdtempSync(join(tmpdir(), 'slate-e2e-export-'))
  await pickFolder(app, parent)
  await openPrivacy(page)
  await page.getByTestId('privacy-export').click()
  await expect(page.getByTestId('privacy-data-note')).toContainText('Exported 1 pages and 0 images to')
  const [folder] = readdirSync(parent)
  expect(folder).toMatch(/^Slate export \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/)
  const manifest = JSON.parse(readFileSync(join(parent, folder!, 'manifest.json'), 'utf8')) as { notebooks: Array<{ sections: Array<{ pages: Array<{ file: string }> }> }> }
  const file = manifest.notebooks[0]!.sections[0]!.pages[0]!.file
  expect(readFileSync(join(parent, folder!, ...file.split('/')), 'utf8')).toContain('portable words')
  for (const f of ['settings.json', 'ai-audit.json']) expect(existsSync(join(parent, folder!, f))).toBe(true)
})

test('a grant is listed with its date, and Withdraw removes it in main', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => window.slate.privacy.grant('updates'))
  await openPrivacy(page)
  const row = page.getByTestId('privacy-consent-updates')
  await expect(row).toContainText(DISCLOSURES.updates.title)
  await expect(row).toContainText('Allowed')
  await page.getByTestId('privacy-withdraw-updates').click()
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId('privacy-consents-empty')).toBeVisible()
  expect((await status(page)).consents.updates).toBeUndefined()
})

test('turning strict mode off first lists every disclosure; Cancel keeps it on, confirming turns it off', async ({ page }) => {
  await openPrivacy(page)
  const box = page.getByTestId('privacy-strict')
  await expect(box).toBeChecked()
  await box.uncheck()
  const list = page.getByTestId('privacy-strict-off-list')
  for (const f of CONSENT_FEATURES) await expect(list).toContainText(DISCLOSURES[f].title)
  await page.getByTestId('privacy-strict-off-no').click()
  await expect(list).toHaveCount(0)
  await expect(box).toBeChecked()
  expect((await status(page)).gdprStrictMode).toBe(true)
  await box.uncheck()
  await page.getByTestId('privacy-strict-off-yes').click()
  await expect(box).not.toBeChecked()
  await expect.poll(async () => (await status(page)).gdprStrictMode).toBe(false)
  await box.check()
  await expect.poll(async () => (await status(page)).gdprStrictMode).toBe(true)
})

test('Erase edit history is offered only with sync off; the page keeps what it shows, undo cannot bring deleted text back, and later edits stay (GDPR-04)', async ({ page }) => {
  const editor = page.getByTestId('box-editor')
  await expect(page.getByTestId('canvas')).toBeVisible()
  await typeBox(page, 'current words')
  await page.evaluate(() => window.slate.settings.set({ syncProvider: 'git', git: { remoteUrl: 'file:///nowhere', branch: 'main', auth: 'system' } }))
  await openPrivacy(page)
  await expect(page.getByTestId('privacy-erase-history')).toBeDisabled()
  await expect(page.getByTestId('privacy-erase')).toContainText('Turn sync off first')
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.slate.settings.set({ syncProvider: null }))
  // A word typed and deleted: the history the erase removes.
  await editor.click()
  await expect(page.locator('[data-testid="box-editor"]:focus')).toBeVisible()
  await page.keyboard.press('End')
  await page.keyboard.type(' ZEBRA')
  for (let i = 0; i < ' ZEBRA'.length; i++) await page.keyboard.press('Backspace')
  await expect(editor).toHaveText('current words')
  await page.keyboard.press('Escape')
  await openPrivacy(page)
  await page.getByTestId('privacy-erase-history').click()
  await page.getByTestId('privacy-history-confirm-yes').click()
  await expect(page.getByTestId('privacy-erase-note')).toContainText('edit history is erased')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toBeHidden()
  await expect(editor).toHaveText('current words')
  await editor.click()
  await expect(page.locator('[data-testid="box-editor"]:focus')).toBeVisible()
  for (let i = 0; i < 3; i++) await page.keyboard.press(`${MOD}+z`)
  await expect(editor).toHaveText('current words')
  await page.keyboard.press('End')
  await page.keyboard.type(' again')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveText('current words again')
  await page.reload()
  await expect(page.getByTestId('box-editor')).toHaveText('current words again')
})

test('Erase all Slate data needs ERASE typed, deletes the data folder and quits to relaunch (GDPR-06, GDPR-18)', async () => {
  // Its own throwaway data folder under this run's temp root, never a real profile.
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-erase-'))
  const { app, page } = await launchApp(userData)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await typeBox(page, 'gone soon')
  await page.evaluate(() => localStorage.setItem('slate:probe', 'x'))
  expect(existsSync(join(userData, 'slate.db'))).toBe(true)
  // A relaunch would start a second app outside the test: keep the exit, drop the new process.
  await app.evaluate(({ app: electronApp }) => {
    Object.assign(electronApp, { relaunch: () => {} })
  })
  await openPrivacy(page)
  await page.getByTestId('privacy-erase-all').click()
  const go = page.getByTestId('privacy-all-confirm-yes')
  await expect(go).toBeDisabled()
  await page.getByTestId('privacy-all-typed').fill('erase')
  await expect(go).toBeDisabled()
  await page.getByTestId('privacy-all-typed').fill('ERASE')
  const closed = new Promise<void>((resolve) => app.once('close', () => resolve()))
  await go.click()
  await closed
  const left = readdirSync(userData)
  for (const gone of ['slate.db', 'slate.db-wal', 'blobs', 'logs', 'security-log', 'vault.json']) expect(left).not.toContain(gone)

  // The next start is a fresh install: no notes, and the browser storage was cleared.
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('canvas')).toBeVisible()
  await expect(second.page.getByTestId('box-editor')).toHaveCount(0)
  expect(await second.page.evaluate(() => localStorage.getItem('slate:probe'))).toBeNull()
  await second.app.close()
})
