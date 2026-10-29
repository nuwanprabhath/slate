import type { Page } from '@playwright/test'
import { expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'
import type { PqReadiness, TransportObservation } from '../../src/shared/api'
import { stubInvoke, unlockedApp } from './states'

/** Every Settings section, as the registry lists them (the nav is the registry rendered), scrolled through. */
test('UI: every Settings section', async ({ app, page }) => {
  test.setTimeout(300_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.keyboard.press(`${MOD}+,`)
  const ids = await page.locator('.settings-nav-item').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').replace('settings-nav-', '')))
  expect(ids.length).toBeGreaterThan(5)
  await page.keyboard.press('Escape')
  for (const id of ids) {
    await reviewUi(app, page, `settings ${id}`, {
      scroll: '[data-testid="settings-pane"]',
      open: async (p) => {
        if (!(await p.getByTestId('settings-dialog').isVisible())) await p.keyboard.press(`${MOD}+,`)
        await p.getByTestId(`settings-nav-${id}`).click()
        await expect(p.getByTestId('settings-heading')).toBeVisible()
      },
    })
  }
})

const SSH_GIT = { syncProvider: 'git', git: { remoteUrl: 'git@github.com:someone-with-a-long-name/my-slate-notes-repository.git', branch: 'main', auth: 'system' } } as const
const CLASSICAL: TransportObservation = { remote: 'git-ssh:github.com', transport: 'ssh', kex: 'ecdh-sha2-nistp256', pq: 'classical', source: 'probe', at: 1 }

/** T-PQ-D2-03: Settings → Sync, "Require post-quantum key exchange" in each state a person reaches. */
test('T-PQ-D2-03: UI: Sync require post-quantum key exchange', async ({ app, page }) => {
  test.setTimeout(600_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate((patch) => window.slate.settings.set({ ...patch, syncRequirePq: false }), SSH_GIT)
  await stubInvoke(app, 'sync:check-transport', [CLASSICAL])
  const states: Array<[string, (p: Page) => Promise<void>]> = [
    ['ssh off', async () => {}],
    [
      'ssh on classical warning',
      async (p) => {
        await p.getByTestId('sync-require-pq-toggle').check()
        await expect(p.getByTestId('sync-require-pq-note')).toContainText('classical key exchange')
      },
    ],
    [
      'onedrive disabled',
      async (p) => {
        await p.getByTestId('sync-provider-onedrive').click()
        await expect(p.getByTestId('sync-require-pq-toggle')).toBeDisabled()
      },
    ],
    [
      'https disabled',
      async (p) => {
        await p.getByTestId('git-remote-url').fill('https://github.com/someone-with-a-long-name/my-slate-notes-repository.git')
        await expect(p.getByTestId('sync-require-pq-toggle')).toBeDisabled()
      },
    ],
  ]
  for (const [name, arrange] of states) {
    await page.evaluate((patch) => window.slate.settings.set({ ...patch, syncRequirePq: name === 'onedrive disabled' }), SSH_GIT)
    await reviewUi(app, page, `sync pq ${name}`, {
      within: '[data-testid="sync-settings"]',
      close: (p) => p.keyboard.press('Escape'),
      open: async (p) => {
        await p.evaluate((patch) => window.slate.settings.set({ ...patch, syncRequirePq: name === 'onedrive disabled' }), SSH_GIT)
        if (!(await p.getByTestId('settings-dialog').isVisible())) await p.keyboard.press(`${MOD}+,`)
        await p.getByTestId('settings-nav-sync').click()
        await expect(p.getByTestId('sync-require-pq')).toBeVisible()
        await arrange(p)
        await p.getByTestId('sync-require-pq').scrollIntoViewIfNeeded()
      },
    })
  }
})

const header = (version: 2 | 3, upgrade: 'running' | 'done'): PqReadiness => ({ atRest: 'symmetric-256', vault: { kind: 'header', version, upgrade }, transports: [], updateSignature: 'ed25519', plaintextSync: false, requirePq: false })

/** T-PQ-D2-03: the vault format banner while the update runs and once it is done. */
test('T-PQ-D2-03: UI: vault format banner', async () => {
  test.setTimeout(480_000)
  const { app, page } = await unlockedApp()
  try {
    await stubInvoke(app, 'vault:pq-readiness', header(2, 'running'))
    const banner = page.getByTestId('vault-format-banner')
    await expect(banner).toContainText('Updating the vault format', { timeout: 15_000 })
    await reviewUi(app, page, 'vault format banner running', { open: async (p) => expect(p.getByTestId('vault-format-banner')).toContainText('Updating') })
    await stubInvoke(app, 'vault:pq-readiness', header(3, 'done'))
    await expect(banner).toContainText('Vault format updated', { timeout: 15_000 })
    await reviewUi(app, page, 'vault format banner done', { open: async (p) => expect(p.getByTestId('vault-format-banner')).toContainText('Vault format updated') })
  } finally {
    await app.close()
  }
})
