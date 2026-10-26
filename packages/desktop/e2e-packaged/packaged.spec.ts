import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectMcp } from '../e2e/mcpClient'

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
test.skip(!built || !existsSync(built.exe), 'run `npm run dist:e2e` first')
const unverified = built && existsSync(built.exe) ? launchable(built.app) : null
// A build that cannot be launched here (unsigned on this Mac, say) says why in `unverified`.
test.skip(unverified !== null, unverified ?? '')

async function launch(userData: string, extraEnv: Record<string, string> = {}) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env
  return electron.launch({
    executablePath: built!.exe,
    // Never save or restore window state (see e2e/fixtures.ts).
    args: process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [],
    env: { ...(inherited as Record<string, string>), SLATE_E2E: '1', SLATE_USER_DATA: userData, ...extraEnv },
  })
}

test('T-B-07: the fuses are the configured ones, file:// has no extra privileges', () => {
  // This build comes from electron-builder.e2e.cjs (--inspect on for Playwright); the release
  // workflow runs the same check against electron-builder.cjs, where --inspect is off.
  const out = execFileSync('node', [join(desktop, '..', '..', 'scripts', 'check-fuses.mjs'), process.platform === 'darwin' ? built!.app : built!.exe, join(desktop, 'electron-builder.e2e.cjs')], { encoding: 'utf8' })
  expect(out).toContain('GrantFileProtocolExtraPrivileges: Disabled')
  expect(out).toContain('EnableNodeCliInspectArguments: Enabled')
})

test('T-POST-13: a packaged app ignores the self-test corruption hook', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), 'slate-packaged-')), { SLATE_TEST_SELFTEST_CORRUPT: 'POST-AES-GCM-ENC', SLATE_FAKE_UPDATE: 'deb', SLATE_FAKE_AUTH: '1' })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('notebook-picker')).toContainText('My Notebook')
    const seen = await app.evaluate(() => [process.env.SLATE_TEST_SELFTEST_CORRUPT ?? null, process.env.SLATE_FAKE_UPDATE ?? null, process.env.SLATE_FAKE_AUTH ?? null])
    expect(seen).toEqual([null, null, null])
    // C12 N2: this e2e build (dist:e2e, --mode e2e) keeps SLATE_E2E, so the window stays hidden; a release scrubs it.
    expect(await app.evaluate(() => process.env.SLATE_E2E ?? null)).toBe('1')
    expect(page.url()).toMatch(/^app:\/\/slate\/index\.html/)
    // C6: a real KAT id, which an unpackaged e2e run obeys (e2e/selftest.spec.ts), and still the notes, not the error screen.
    expect(page.url()).not.toContain('selftest-failed')
    expect((await page.evaluate(() => window.slate.vault.status())).selfTest).toMatchObject({ passed: true, failed: [] })
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('the packaged app opens its database and keeps text across a relaunch', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-packaged-'))
  let app = await launch(userData)
  try {
    let page = await app.firstWindow()
    await expect(page).toHaveTitle('Slate')
    await expect(page.getByTestId('notebook-picker')).toContainText('My Notebook')
    await page.getByTestId('canvas').dblclick({ position: { x: 200, y: 150 } })
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

test('the packaged app has a visible Check for Updates menu item', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), 'slate-packaged-')))
  try {
    await app.firstWindow()
    const visible = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('check-updates')!.visible)
    expect(visible).toBe(true)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('the packaged app runs @slate/native with the bundled FIPS provider in approved mode (audit C2)', async () => {
  expect(existsSync(join(built!.resources, 'fips', 'fipsmodule.cnf'))).toBe(true)
  const userData = mkdtempSync(join(tmpdir(), 'slate-packaged-'))
  const app = await launch(userData)
  try {
    const page = await app.firstWindow()
    const status = await page.evaluate(() => window.slate.vault.moduleStatus())
    expect(status).toMatchObject({ available: true, approvedMode: true, errorState: false, problem: null, version: '3.1.2', cmvp: 4985 })
    // The runtime config is written under userData, never next to the read-only provider.
    expect(existsSync(join(userData, 'fips', 'openssl-fips.cnf'))).toBe(true)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('the packaged slate-mcp launcher answers listTools with five tools', async () => {
  const launcher = join(built!.resources, 'bin', process.platform === 'win32' ? 'slate-mcp.cmd' : 'slate-mcp')
  expect(existsSync(launcher)).toBe(true)
  if (process.platform !== 'win32') expect(statSync(launcher).mode & 0o777).toBe(0o755)
  const userData = mkdtempSync(join(tmpdir(), 'slate-packaged-'))
  const app = await launch(userData) // creates the database the server opens
  await app.firstWindow()
  await app.close()
  const mcp = await connectMcp(userData, launcher)
  try {
    const { tools } = await mcp.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['append_to_page', 'create_page', 'list_tree', 'read_page', 'search'])
  } finally {
    await mcp.close()
  }
})
