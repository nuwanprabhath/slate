import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Cocoa defaults: a test launch never saves or restores window state, so a crashed run cannot make later launches ask to reopen windows. */
export const NO_WINDOW_RESTORE: string[] = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : []

/**
 * C5: with SLATE_CSP_REPORT set to a file, every window's Content-Security-Policy complaints (the report-only
 * Trusted Types directive among them) are appended to it, so one full e2e run lists what enforcing would break.
 */
const POLICY_MESSAGE = /Content Security Policy|Trusted|require-trusted-types/i

function watchPolicyViolations(app: ElectronApplication): void {
  const file = process.env.SLATE_CSP_REPORT
  if (!file) return
  const watch = (p: Page): void => {
    p.on('console', (m) => {
      if (POLICY_MESSAGE.test(m.text())) appendFileSync(file, `${m.text().replace(/\s+/g, ' ')}\n`)
    })
  }
  app.windows().forEach(watch)
  app.on('window', watch)
}

/** `switches` go on the app's real command line (e.g. `--no-sandbox` for the POAM-16 notice). */
export async function launchApp(userData: string, env: Record<string, string> = {}, switches: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  // ELECTRON_RUN_AS_NODE (set for `npm run test:main`, or inherited from a parent shell) would make
  // Electron boot as plain Node, so it must not leak into the app under test.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env
  const app = await electron.launch({
    // Playwright adds --no-sandbox on Linux unless told otherwise, which turns Chromium's sandbox off for
    // every child: the app under test must run sandboxed, as it does for users (T-ZERO-06).
    chromiumSandbox: true,
    args: [join(__dirname, '..', 'out', 'main', 'index.js'), ...NO_WINDOW_RESTORE, ...switches],
    env: { ...(inherited as Record<string, string>), ...env, SLATE_E2E: '1', SLATE_USER_DATA: userData },
  })
  watchPolicyViolations(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/**
 * Z-6 (audit §4.3, C7): a successful unlock opens the notes in a new window and destroys the lock window, so
 * the renderer process that saw the password exits. Waits for that and returns the window now on screen.
 */
export async function windowAfterUnlock(app: ElectronApplication, lock: Page): Promise<Page> {
  await expect.poll(() => lock.isClosed(), { timeout: 30_000 }).toBe(true)
  let next: Page | undefined
  await expect.poll(() => (next = app.windows().find((w) => w !== lock && !w.isClosed())) !== undefined, { timeout: 15_000 }).toBe(true)
  await next!.waitForLoadState('domcontentloaded')
  return next!
}

/** Types `secret` on the lock screen `lock`, unlocks, and returns the notes window that replaces it (Z-6). */
export async function unlockWith(app: ElectronApplication, lock: Page, secret: string): Promise<Page> {
  await lock.getByTestId('lock-secret').fill(secret)
  await lock.getByTestId('lock-unlock').click()
  return windowAfterUnlock(app, lock)
}

/**
 * Clicks a native menu item in a fresh main-process task. Playwright evaluates main-process code
 * through the inspector, which can run it in the middle of another JS call (one was mid-query in
 * DocStore.list), so a click that touches the database must not run inside the evaluate itself.
 */
export async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    setImmediate(() => Menu.getApplicationMenu()!.getMenuItemById(itemId)!.click())
  }, id)
}

/** Double-click on empty canvas makes a box there and focuses it (a single click only places a caret). */
export async function createBoxAt(page: Page, x: number, y: number): Promise<void> {
  await page.getByTestId('canvas').dblclick({ position: { x, y } })
}

/**
 * One X display per Playwright worker, on Linux. Two apps on one display take the X pointer grab
 * that backs Chromium's pointer capture from each other mid-drag, and share one X selection for the
 * clipboard; a display per worker removes both at the source, so playwright.config.ts does not have
 * to find the specs that drag or copy. `-displayfd` lets Xvfb pick a free display and report it, so
 * two workers (or a surrounding `xvfb-run`) never pick the same number.
 *
 * macOS has one window server and one clipboard per machine and no Xvfb, so there the specs that
 * share them stay in the serial `os-shared` project.
 */
async function startXvfb(): Promise<{ display: string; stop: () => Promise<void> }> {
  const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] })
  const number = await new Promise<string>((resolve, reject) => {
    let reported = ''
    ;(child.stdio[3] as Readable).on('data', (chunk: Buffer) => {
      reported += chunk.toString()
      if (reported.includes('\n')) resolve(reported.trim())
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Xvfb exited with ${String(code)} before reporting a display`)))
    setTimeout(() => reject(new Error('Xvfb reported no display within 15s')), 15_000).unref()
  })
  return {
    display: `:${number}`,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      }),
  }
}

export const test = base.extend<{ userData: string; app: ElectronApplication; page: Page }, { display: void }>({
  /** The worker's own display, set on the environment every launch inherits (see `launchApp`). */
  display: [
    async ({}, use) => {
      if (process.platform !== 'linux') {
        await use()
        return
      }
      const xvfb = await startXvfb()
      const outer = process.env.DISPLAY
      process.env.DISPLAY = xvfb.display
      try {
        await use()
      } finally {
        if (outer === undefined) delete process.env.DISPLAY
        else process.env.DISPLAY = outer
        await xvfb.stop()
      }
    },
    { scope: 'worker', auto: true },
  ],
  userData: async ({}, use) => {
    await use(mkdtempSync(join(tmpdir(), 'slate-e2e-')))
  },
  app: async ({ userData }, use) => {
    const { app } = await launchApp(userData)
    await use(app)
    await app.close()
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect } from '@playwright/test'
