import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const desktop = join(__dirname, '..')
const release = join(desktop, 'release')

/** The unpacked build electron-builder --dir leaves behind, or null if it has not been built. */
function findExecutable(): { exe: string; resources: string; app: string } | null {
  if (!existsSync(release)) return null
  if (process.platform === 'darwin') {
    const dir = readdirSync(release).find((d) => d.startsWith('mac'))
    if (!dir) return null
    const app = join(release, dir, 'Slate.app')
    return { app, exe: join(app, 'Contents', 'MacOS', 'Slate'), resources: join(app, 'Contents', 'Resources') }
  }
  if (process.platform === 'linux') {
    const dir = join(release, 'linux-unpacked')
    return { app: dir, exe: join(dir, 'slate'), resources: join(dir, 'resources') }
  }
  const dir = join(release, 'win-unpacked')
  return { app: dir, exe: join(dir, 'Slate.exe'), resources: join(dir, 'resources') }
}

/** Never launch a macOS app that fails codesign: a crash dialog would land on the user's screen. */
function launchable(app: string): string | null {
  if (process.platform !== 'darwin') return null
  try {
    execFileSync('node', [join(desktop, '..', '..', 'scripts', 'verify-mac-app.mjs'), app], { stdio: 'pipe' })
    return null
  } catch (e) {
    return `signature of ${app} does not verify: ${String(e)}`
  }
}

const built = findExecutable()
test.skip(!built || !existsSync(built.exe), 'run `npm run dist:dir` first')
const unverified = built && existsSync(built.exe) ? launchable(built.app) : null
test.skip(unverified !== null, unverified ?? '')

async function launch(userData: string) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env
  return electron.launch({
    executablePath: built!.exe,
    env: { ...(inherited as Record<string, string>), SLATE_E2E: '1', SLATE_USER_DATA: userData },
  })
}

test('the packaged app opens its database and keeps text across a relaunch', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-packaged-'))
  let app = await launch(userData)
  try {
    let page = await app.firstWindow()
    await expect(page).toHaveTitle('Slate')
    await expect(page.getByTestId('notebook-picker')).toContainText('My Notebook')
    await page.getByTestId('canvas').click({ position: { x: 200, y: 150 } })
    await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
    await page.keyboard.type('packaged hello')
    await expect(page.getByTestId('box-editor')).toHaveText('packaged hello')
    // Auto-push writes on idle; blurring flushes the page before the window closes.
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await page.waitForTimeout(500)
    await app.close()

    app = await launch(userData)
    page = await app.firstWindow()
    await expect(page.getByTestId('box-editor')).toHaveText('packaged hello')
  } finally {
    await app.close().catch(() => undefined)
  }
})
