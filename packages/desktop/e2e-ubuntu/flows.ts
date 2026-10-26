import { execFileSync } from 'node:child_process'
import { expect, type Page } from '@playwright/test'
import type { Device } from './devices'

/** User journeys shared by the scenarios; each works on both devices and, where noted, on v0.1.0. */

/** Sync → git with `device`'s URL for the shared repository. Also v0.1.0. */
export async function configureGit(page: Page, device: Device): Promise<void> {
  await page.getByTestId('sync-menu').click()
  await page.getByTestId('sync-settings-open').click()
  await expect(page.getByTestId('sync-settings')).toBeVisible()
  await page.getByTestId('sync-provider-git').check()
  await page.getByTestId('git-remote-url').fill(device.remoteUrl)
  await page.getByTestId('sync-settings-save').click()
  // Save waits for a first sync (clone, vault check, push): seconds of git through a bind mount.
  await expect(page.getByTestId('sync-settings')).toHaveCount(0, { timeout: 60_000 })
}

/** A new box at (x, y) with `text` typed in. Also v0.1.0. */
export async function writeNote(page: Page, text: string, x = 200, y = 150): Promise<void> {
  await page.getByTestId('canvas').dblclick({ position: { x, y } })
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveCount(1)
  await page.keyboard.type(text)
}

/** Pages whose text contains `text`, by the app's own search (every notebook). Also v0.1.0. */
export function searchCount(page: Page, text: string): Promise<number> {
  return page.evaluate(
    async (t) => (await window.slate.search.query({ text: t, matchCase: true, wholeWord: false, regex: false, scope: { kind: 'all' } })).total,
    text,
  )
}

/** Waits until the device's search finds `text`: synced in and indexed. */
export async function expectNote(page: Page, text: string, timeout = 90_000): Promise<void> {
  await expect.poll(() => searchCount(page, text).catch(() => -1), { timeout, intervals: [500, 1000, 2000] }).toBeGreaterThan(0)
}

/** Resolves once the sync button reports a completed sync (syncs run back to back, so an observer, not a poll). */
export function synced(page: Page, timeoutMs = 60_000): Promise<void> {
  return page.evaluate(
    (ms) =>
      new Promise<void>((resolve, reject) => {
        const button = document.querySelector('[data-testid="sync-status"]')
        if (!button) return reject(new Error('no sync button'))
        const done = () => button.getAttribute('data-state') === 'idle-synced' && resolve()
        if (done()) return
        const observer = new MutationObserver(() => done() && observer.disconnect())
        observer.observe(button, { attributes: true, attributeFilter: ['data-state'] })
        setTimeout(() => reject(new Error(`never synced: ${button.getAttribute('title') ?? ''}`)), ms)
      }),
    timeoutMs,
  )
}

export async function openSecurity(page: Page): Promise<void> {
  await page.getByTestId('activity-settings').click()
  await page.locator('.settings-nav-item', { hasText: 'Security' }).click()
  await expect(page.getByTestId('settings-heading')).toHaveText('Security')
}

export async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-heading')).toHaveCount(0)
}

/** Settings → Security → Encrypt: the whole wizard with the standard profile. Returns the recovery key. */
export async function encrypt(page: Page, password: string): Promise<string> {
  await openSecurity(page)
  await expect(page.getByTestId('security-status')).toHaveText('Your notes are not encrypted.')
  await page.getByTestId('security-encrypt').click()
  const wizard = page.getByTestId('encrypt-wizard')
  await page.getByTestId('wizard-next').click()
  await expect(wizard).toContainText('Update your other devices first')
  await page.getByTestId('wizard-next').click()
  await page.getByTestId('wizard-password').fill(password)
  await page.getByTestId('wizard-password-again').fill(password)
  await page.getByTestId('wizard-next').click()
  const key = page.getByTestId('recovery-key')
  await expect(key.locator('span')).toHaveCount(14, { timeout: 60_000 })
  const recoveryKey = (await key.locator('span').allTextContents()).join('-')
  await page.getByTestId('wizard-next').click()
  await page.getByTestId('recovery-confirm-input').fill(recoveryKey)
  await page.getByTestId('wizard-next').click()
  await page.getByTestId('wipe-confirm').check()
  await page.getByTestId('wizard-next').click()
  await expect(wizard).toHaveCount(0, { timeout: 120_000 })
  return recoveryKey
}

/** The join banner on a device whose sync folder another device encrypted: joins with `password`. */
export async function join(page: Page, password: string): Promise<void> {
  await expect(page.getByTestId('vault-join-banner')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('vault-join-open').click()
  await page.getByTestId('vault-join-password').fill(password)
  await page.getByTestId('vault-join-submit').click()
  await expect(page.getByTestId('vault-join-banner')).toHaveCount(0, { timeout: 120_000 })
}

/** The device's window showing the lock screen. */
export async function lockWindow(device: Device, timeout = 30_000): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(
      async () => {
        for (const w of device.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return (found = w) !== undefined
        return false
      },
      { timeout },
    )
    .toBe(true)
  return found!
}

/** Unlocks on the lock screen and returns the notes window that replaces it (the lock window's renderer exits, Z-6). */
export async function unlock(device: Device, lock: Page, secret: string): Promise<Page> {
  await lock.getByTestId('lock-secret').fill(secret)
  await lock.getByTestId('lock-unlock').click()
  return windowAfterLock(device, lock)
}

export async function windowAfterLock(device: Device, lock: Page): Promise<Page> {
  await expect.poll(() => lock.isClosed(), { timeout: 60_000 }).toBe(true)
  let next: Page | undefined
  await expect.poll(() => (next = device.windows().find((w) => w !== lock)) !== undefined, { timeout: 30_000 }).toBe(true)
  await next!.waitForLoadState('domcontentloaded')
  await expect(next!.getByTestId('canvas')).toBeVisible({ timeout: 30_000 })
  return next!
}

/** Settings → Security → change password. */
export async function changePassword(page: Page, current: string, next: string): Promise<void> {
  await openSecurity(page)
  await page.getByTestId('security-current').fill(current)
  await page.getByTestId('security-new').fill(next)
  await page.getByTestId('security-new-again').fill(next)
  await page.getByTestId('security-change-submit').click()
  await expect(page.getByTestId('security-change-message')).toHaveText('Password changed.', { timeout: 60_000 })
  await closeSettings(page)
}

/** A key change in Settings → Security: password(s), the new recovery key typed back, then the change. */
export async function rekey(page: Page, kind: 'rotate' | 'upgrade' | 'convert', password: string, newPassword?: string): Promise<void> {
  await openSecurity(page)
  await expect(page.getByTestId('security-keys')).toBeVisible()
  await page.getByTestId(`security-${kind}`).click({ timeout: 60_000 })
  await page.getByTestId('security-rekey-password').fill(password)
  if (newPassword) {
    await page.getByTestId('security-rekey-new').fill(newPassword)
    await page.getByTestId('security-rekey-new-again').fill(newPassword)
  }
  await page.getByTestId('security-rekey-continue').click()
  const key = page.getByTestId('security-rekey-recovery-key')
  await expect(key.locator('span')).toHaveCount(14, { timeout: 60_000 })
  const recoveryKey = (await key.locator('span').allTextContents()).join('-')
  await page.getByTestId('security-rekey-confirm').fill(recoveryKey)
  await page.getByTestId('security-rekey-run').click()
}

/** The shared bare repository, read on the host. */
export function bareRepo(bare: string) {
  const git = (...args: string[]) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' })
  return {
    git,
    files: (): string[] => {
      try {
        return git('ls-tree', '-r', '--name-only', 'main').trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    /** Every object reachable from main, as git prints it (decompressed). */
    contents: (): string =>
      git('rev-list', '--objects', 'main')
        .trim()
        .split('\n')
        .map((l) => l.split(' ')[0]!)
        .map((sha) => execFileSync('git', ['--git-dir', bare, 'cat-file', '-p', sha]).toString('latin1'))
        .join('\n'),
    header: (): { version: number; keyEpoch: number; profile?: string } => JSON.parse(git('show', 'main:e2ee/vault.json')) as { version: number; keyEpoch: number; profile?: string },
  }
}
