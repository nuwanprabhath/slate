import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchApp, MOD, test, windowAfterUnlock } from './fixtures'

// Audit §6.6 (T-POL) on a real fips-140-3 vault: the e2e hook makes it with SLATE_TEST_PROFILE.
const PASSWORD = 'e2e policy password 15+'
const FIPS = { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD, SLATE_TEST_PROFILE: 'fips-140-3' }

/**
 * Types `secret`, submits, and waits for the lock screen to show `message`. The error text of an earlier attempt is
 * still on screen, so a retry loop waits until the previous submit has finished (it clears the field and the typed
 * flag when it ends) before typing.
 */
async function attempt(page: Page, secret: string, message: RegExp = /didn.t work/): Promise<string> {
  await expect(async () => {
    await page.getByTestId('lock-secret').fill(secret)
    await expect(page.getByTestId('lock-unlock')).toBeEnabled({ timeout: 500 })
  }).toPass({ timeout: 10_000 })
  await page.getByTestId('lock-unlock').click()
  const error = page.getByTestId('lock-error')
  await expect(error).toHaveText(message)
  return (await error.textContent()) ?? ''
}

const throttleFile = (userData: string): { failures: number[]; lockedUntil: number | null } => JSON.parse(readFileSync(join(userData, 'unlock-throttle.json'), 'utf8')) as { failures: number[]; lockedUntil: number | null }

test('T-POL-04: three wrong passwords lock password unlock; the recovery key is not throttled; the vault stays shut', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, FIPS)
  try {
    await expect(page.getByTestId('lock-screen')).toBeVisible()
    for (const n of [1, 2, 3]) await attempt(page, `wrong password number ${n}`)
    // The file is written by main while locked (no key, so no seal yet).
    await expect.poll(() => throttleFile(userData).lockedUntil).toBeGreaterThan(Date.now() + 170 * 60_000)
    // The fourth attempt is refused without trying, even with the right password.
    await attempt(page, PASSWORD, /Too many wrong passwords/)
    await expect(page.getByTestId('lock-screen')).toBeVisible()
    // The recovery key is the administrator release: a (wrong) key is judged, not throttled.
    await page.getByTestId('lock-switch').click()
    await attempt(page, 'AAAA-BBBB-CCCC-DDDD', /recovery key didn.t work/)
  } finally {
    await app.close()
  }
})

test('T-POL-04: a restart keeps the lockout, and a standard vault is never throttled', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData, FIPS)
  for (const n of [1, 2, 3]) await attempt(first.page, `wrong password number ${n}`)
  await expect.poll(() => throttleFile(userData).lockedUntil).not.toBeNull()
  await first.app.close()
  const second = await launchApp(userData, FIPS)
  try {
    await attempt(second.page, PASSWORD, /Too many wrong passwords/)
  } finally {
    await second.app.close()
  }
  const std = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const plain = await launchApp(std, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
  try {
    for (const n of [1, 2, 3, 4]) await attempt(plain.page, `wrong password number ${n}`)
    expect(existsSync(join(std, 'unlock-throttle.json'))).toBe(false)
  } finally {
    await plain.app.close()
  }
})

test('T-POL-02, T-POL-03: a fips-140-3 vault offers no "Never", and lock on sleep and screen lock are forced on', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, FIPS)
  try {
    await page.getByTestId('lock-secret').fill(PASSWORD)
    await page.getByTestId('lock-unlock').click()
    const notes = await windowAfterUnlock(app, page)
    await expect(notes.getByTestId('canvas')).toBeVisible()
    await notes.keyboard.press(`${MOD}+,`)
    await notes.locator('.settings-nav-item', { hasText: 'Security' }).click()
    const idle = notes.getByTestId('security-idle')
    await expect(idle).toBeVisible()
    const options = await idle.locator('option').allTextContents()
    expect(options).not.toContain('Never')
    expect(options).toEqual(['5 minutes', '15 minutes'])
    await expect(idle).toHaveValue('15')
    for (const id of ['security-lock-sleep', 'security-lock-screen']) {
      await expect(notes.getByTestId(id)).toBeChecked()
      await expect(notes.getByTestId(id)).toBeDisabled()
    }
  } finally {
    await app.close()
  }
})

test('T-POL-08: a remote image is blocked by the page policy and nothing answers it', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData, FIPS)
  try {
    await page.getByTestId('lock-secret').fill(PASSWORD)
    await page.getByTestId('lock-unlock').click()
    const notes = await windowAfterUnlock(app, page)
    await expect(notes.getByTestId('canvas')).toBeVisible()
    const answered: string[] = []
    const blocked: string[] = []
    notes.on('response', (r) => answered.push(r.url()))
    notes.on('requestfailed', (r) => blocked.push(`${r.url()} ${r.failure()?.errorText ?? ''}`))
    const csp = await notes.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '')
    const img = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src')) ?? ''
    expect(img).not.toMatch(/https?:/)
    const result = await notes.evaluate(
      () =>
        new Promise<{ loaded: boolean; violated: boolean }>((resolve) => {
          let violated = false
          document.addEventListener('securitypolicyviolation', () => (violated = true), { once: true })
          const el = new Image()
          el.onload = () => resolve({ loaded: true, violated })
          el.onerror = () => setTimeout(() => resolve({ loaded: false, violated }), 100)
          el.src = 'https://example.invalid/pixel.png'
        }),
    )
    expect(result).toEqual({ loaded: false, violated: true })
    // Chromium reports the attempt, but the page policy fails it before any connection: nothing answers.
    expect(answered.filter((u) => u.includes('example.invalid'))).toEqual([])
    expect(blocked.filter((u) => u.includes('example.invalid')).every((u) => u.endsWith(' csp'))).toBe(true)
  } finally {
    await app.close()
  }
})
