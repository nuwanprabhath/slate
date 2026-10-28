import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { createBoxAt, expect, launchApp, MOD, test, unlockWith, windowAfterUnlock } from './fixtures'

const PASSWORD = 'e2e lock password'

/** The lock replaces the window (§15 N6): the newest window is the one on screen. */
async function lockWindow(app: ElectronApplication): Promise<Page> {
  await expect.poll(async () => {
    for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return true
    return false
  }, { timeout: 15_000 }).toBe(true)
  for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return w
  throw new Error('no lock window')
}

async function noteIpcRefused(page: Page): Promise<void> {
  const outcome = await page.evaluate(() =>
    window.slate.docs.list('').then(
      () => 'allowed',
      (e: unknown) => String(e),
    ),
  )
  expect(outcome).toContain('locked')
}

/** Whether `pid` is a live process: signal 0 checks without signalling, and throws ESRCH once it has exited. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function unlock(page: Page, password: string): Promise<void> {
  await page.getByTestId('lock-secret').fill(password)
  await page.getByTestId('lock-unlock').click()
}

async function writeNote(userData: string, text: string): Promise<void> {
  const { app, page } = await launchApp(userData)
  await createBoxAt(page, 150, 120)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type(text)
  await page.waitForTimeout(300)
  await app.close()
}

test('an encrypted vault opens locked, unlocks with the password, and locks with Mod+Shift+L', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  await writeNote(userData, 'secret note')
  const { app, page } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
  try {
    // The e2e hook encrypted the folder: no plaintext copy of the notes is left.
    expect(existsSync(join(userData, 'vault.json'))).toBe(true)
    expect(existsSync(join(userData, 'slate.db'))).toBe(false)
    expect(readdirSync(userData).some((f) => /^slate-[0-9a-f]{8}\.db$/.test(f))).toBe(true)

    await expect(page.getByTestId('lock-screen')).toBeVisible()
    await expect(page.getByTestId('lock-secret')).toBeFocused()
    await noteIpcRefused(page)
    // From the main process: the page's own fetch of the scheme is cross-origin.
    expect(await app.evaluate(async ({ net }) => (await net.fetch('slate-blob://blob/x.png')).status)).toBe(423)

    await unlock(page, 'not the password')
    await expect(page.getByTestId('lock-error')).toHaveText("That password didn't work")
    await expect(page.getByTestId('lock-screen')).toBeVisible()

    // T-ZERO-05 (Z-6): the renderer process that held the typed password exits once the vault unlocks.
    const lockPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId())
    expect(processAlive(lockPid)).toBe(true)
    const notes = await unlockWith(app, page, PASSWORD)
    await expect(notes.getByTestId('box').first()).toContainText('secret note', { timeout: 15_000 })
    await expect.poll(() => processAlive(lockPid), { timeout: 15_000 }).toBe(false)
    const notesPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId())
    expect(notesPid).not.toBe(lockPid)

    await notes.getByTestId('box-editor').first().click()
    // The lock replaces this window on the key-down, so the press may find its page already closed before the
    // key-up; that is the lock working. lockWindow below is what asserts it happened.
    await notes.keyboard.press(`${MOD}+Shift+L`).catch((e: Error) => {
      if (!/Target page, context or browser has been closed/.test(e.message)) throw e
    })
    const locked = await lockWindow(app)
    await noteIpcRefused(locked)

    const again = await unlockWith(app, locked, PASSWORD)
    await expect(again.getByTestId('box').first()).toContainText('secret note', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('T-ZERO-05: the lock window\'s renderer process, which held the typed password, has exited after unlock (Z-6)', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
  try {
    await expect(page.getByTestId('lock-screen')).toBeVisible()
    const pid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId())
    expect(processAlive(pid)).toBe(true)
    await unlockWith(app, page, PASSWORD)
    // process.kill(pid, 0) throws ESRCH: the process is gone, not merely hidden.
    await expect.poll(() => processAlive(pid), { timeout: 15_000 }).toBe(false)
  } finally {
    await app.close()
  }
})

test('the recovery-key link switches the field, and idle time locks the vault', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  await writeNote(userData, 'idle note')
  const first = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
  await expect(first.page.getByTestId('lock-screen')).toBeVisible()
  await first.app.close()

  const { app, page } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD, SLATE_TEST_IDLE_MS: '3000' })
  try {
    await page.getByTestId('lock-switch').click()
    await expect(page.getByTestId('lock-secret')).toHaveAttribute('placeholder', 'Recovery key')
    await page.getByTestId('lock-switch').click()
    await unlock(page, PASSWORD)
    const notes = await windowAfterUnlock(app, page)
    // Under load the 3 s idle lock can replace the window before the note is looked at. Either way
    // the lock window that follows is a new one, which only a lock after a real unlock opens.
    const box = notes.getByTestId('box').first()
    await expect.poll(async () => notes.isClosed() || ((await box.textContent({ timeout: 500 }).catch(() => '')) ?? '').includes('idle note'), { timeout: 15_000 }).toBe(true)
    const locked = await lockWindow(app)
    expect(locked).not.toBe(page)
    expect(locked).not.toBe(notes)
    await noteIpcRefused(locked)
  } finally {
    await app.close()
  }
})

test('the toolbar lock button shows only for an unlocked encrypted vault and locks Slate', async () => {
  const plain = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')))
  try {
    await expect(plain.page.getByTestId('sync-status')).toBeVisible()
    await expect(plain.page.getByTestId('toolbar-lock')).toHaveCount(0)
  } finally {
    await plain.app.close()
  }

  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
  try {
    const notes = await unlockWith(app, page, PASSWORD)
    const lock = notes.getByTestId('toolbar-lock')
    await expect(lock).toBeVisible({ timeout: 15_000 })
    await expect(lock).toHaveAttribute('aria-label', 'Lock Slate')
    await expect(lock).toHaveAttribute('title', /^Lock Slate \((⌘⇧L|Ctrl\+Shift\+L)\)$/)
    await lock.click().catch((e: Error) => {
      if (!/Target page, context or browser has been closed/.test(e.message)) throw e
    })
    await noteIpcRefused(await lockWindow(app))
  } finally {
    await app.close()
  }
})
