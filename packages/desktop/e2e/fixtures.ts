import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

export async function launchApp(userData: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  // ELECTRON_RUN_AS_NODE (set for `npm run test:main`, or inherited from a parent shell) would make
  // Electron boot as plain Node, so it must not leak into the app under test.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...(inherited as Record<string, string>), ...env, SLATE_E2E: '1', SLATE_USER_DATA: userData },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export const test = base.extend<{ userData: string; app: ElectronApplication; page: Page }>({
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
