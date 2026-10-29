import type { ElectronApplication, Page } from '@playwright/test'
import { expect, MOD, test } from '../fixtures'
import { EVERY_THEME, expectButtonVisible } from './controls'
import { reviewUi } from './review'
import type { CryptoModuleStatus, PqReadiness, TransportObservation } from '../../src/shared/api'
import { stubInvoke, unlockedApp } from './states'

async function openSecurity(page: Page): Promise<void> {
  if (!(await page.getByTestId('settings-dialog').isVisible())) await page.keyboard.press(`${MOD}+,`)
  await page.getByTestId('settings-nav-security').click()
  await expect(page.getByTestId('security-change-password')).toBeVisible()
}

/** Settings → Security of an encrypted vault, the change-password form first. */
test('UI: Security section of an encrypted vault', async () => {
  test.setTimeout(240_000)
  const { app, page } = await unlockedApp()
  try {
    await reviewUi(app, page, 'security encrypted', { open: openSecurity, scroll: '[data-testid="settings-body"]' })
    // Change password alone, so its screenshot shows the whole form; then with a weak password typed.
    await reviewUi(app, page, 'security change password', {
      within: '[data-testid="security-change-password"]',
      open: async (p) => {
        await openSecurity(p)
        await p.getByTestId('security-change-password').scrollIntoViewIfNeeded()
      },
    })
    await reviewUi(app, page, 'security change password weak', {
      within: '[data-testid="security-change-password"]',
      open: async (p) => {
        await openSecurity(p)
        await p.getByTestId('security-new').fill('short')
        await expect(p.getByTestId('security-new-strength')).not.toContainText('A few unrelated words')
        await p.getByTestId('security-change-password').scrollIntoViewIfNeeded()
      },
    })
  } finally {
    await app.close()
  }
})

/**
 * Settings → Security in every built-in theme: "Check now", "Rotate keys…" and "Convert to FIPS
 * 140-3…" must read as buttons (in Folio they were a faint label on the panel).
 */
test('UI: Security section buttons in every built-in theme', async () => {
  test.setTimeout(600_000)
  const { app, page } = await unlockedApp()
  try {
    await reviewUi(app, page, 'security every theme', {
      themes: EVERY_THEME,
      scroll: '[data-testid="settings-body"]',
      open: async (p) => {
        await openSecurity(p)
        for (const id of ['security-pq-check', 'security-rotate', 'security-convert', 'security-change-submit']) {
          const button = p.getByTestId(id)
          await expect(button).toBeVisible()
          await expectButtonVisible(button, id)
        }
      },
    })
  } finally {
    await app.close()
  }
})

const OBS = { remote: 'git-ssh:github.com', transport: 'ssh', source: 'probe', at: 1 } as const
const READY: PqReadiness = { atRest: 'symmetric-256', vault: { kind: 'none' }, transports: [], updateSignature: 'ed25519', plaintextSync: false, requirePq: false }
const header = (version: 1 | 2 | 3, upgrade: 'none' | 'waiting-devices' | 'running' | 'offer-v1' | 'done', devices?: string[]): PqReadiness['vault'] => ({ kind: 'header', version, upgrade, ...(devices ? { waiting: { reason: 'devices' as const, devices } } : {}) })
const STATES: Array<[string, PqReadiness]> = [
  ['v3 hybrid', { ...READY, vault: header(3, 'done'), transports: [{ ...OBS, kex: 'mlkem768x25519-sha256', pq: 'hybrid' }], updateSignature: 'ml-dsa-65+ed25519' }],
  [
    'v2 waiting classical',
    {
      ...READY,
      vault: header(2, 'waiting-devices', ['Work laptop with a rather long device name', 'Home desktop']),
      transports: [
        { ...OBS, kex: 'ecdh-sha2-nistp256', pq: 'classical' },
        { ...OBS, remote: 'onedrive:graph.microsoft.com', transport: 'tls', kex: 'X25519MLKEM768', pq: 'hybrid' },
        { ...OBS, remote: 'git-https:github.com', transport: 'tls', kex: null, pq: 'classical' },
      ],
    },
  ],
  ['v1 upgrade', { ...READY, vault: header(1, 'offer-v1'), transports: [{ ...OBS, kex: null, pq: 'unknown' }] }],
  ['plaintext sync', { ...READY, plaintextSync: true }],
]

/** T-PQ-D1-03: Settings → Security → Post-quantum readiness in four states, audited in every theme and width. */
test('T-PQ-D1-03: UI: Post-quantum readiness', async () => {
  test.setTimeout(480_000)
  const { app, page } = await unlockedApp()
  try {
    for (const [name, readiness] of STATES) {
      await stubInvoke(app, 'vault:pq-readiness', readiness)
      if (readiness.vault.kind === 'header' && readiness.vault.version === 1) {
        const info = await page.evaluate(() => window.slate.vault.keysInfo())
        await stubInvoke(app, 'vault:keys-info', { ...info, headerVersion: 1, canUpgrade: true })
      }
      await page.keyboard.press('Escape')
      await reviewUi(app, page, `security pq ${name}`, {
        within: '[data-testid="security-pq"]',
        close: (p) => p.keyboard.press('Escape'),
        open: async (p) => {
          await openSecurity(p)
          await expect(p.getByTestId('security-pq')).toBeVisible()
          await p.getByTestId('security-pq').scrollIntoViewIfNeeded()
        },
      })
    }
    // Check now asks main and shows its answer; the v1 action opens the Encryption keys group's own flow.
    await stubInvoke(app, 'vault:pq-readiness', STATES[2]![1])
    await stubInvoke(app, 'sync:check-transport', [{ ...OBS, kex: 'mlkem768x25519-sha256', pq: 'hybrid' }])
    await page.keyboard.press('Escape')
    await openSecurity(page)
    await page.getByTestId('security-pq-check').click()
    await expect(page.getByTestId('security-pq-sync')).toContainText('Post-quantum key exchange (ML-KEM)')
    await page.getByTestId('security-pq-upgrade').click()
    await expect(page.getByTestId('security-rekey-upgrade')).toBeVisible()
  } finally {
    await app.close()
  }
})

/** Main's probe answers only when the scenario says so, so the busy state can be looked at. */
async function holdProbe(app: ElectronApplication, value: TransportObservation[]): Promise<void> {
  await app.evaluate(({ ipcMain }, v) => {
    const g = globalThis as { releaseProbe?: () => void }
    ipcMain.removeHandler('sync:check-transport')
    ipcMain.handle('sync:check-transport', () => new Promise((resolve) => (g.releaseProbe = () => resolve(v))))
  }, value)
}
const releaseProbe = (app: ElectronApplication) => app.evaluate(() => (globalThis as { releaseProbe?: () => void }).releaseProbe?.())

const LONG_NAME = 'nuwan-ubuntu-workstation-in-the-upstairs-office-with-a-very-long-hostname'
const waitingFor = (devices: string[]): PqReadiness['vault'] => ({ kind: 'header', version: 2, upgrade: 'waiting-devices', waiting: { reason: 'devices', devices } })

/** The maintainer's 0.4.0 report: Check now changed nothing on screen, and "Waiting for 1 device" named no device. */
test('UI: Post-quantum readiness, Check now and the devices it waits for', async () => {
  test.setTimeout(900_000)
  const { app, page } = await unlockedApp()
  const pq = async (p: Page) => {
    await openSecurity(p)
    await expect(p.getByTestId('security-pq')).toBeVisible()
    await p.getByTestId('security-pq').scrollIntoViewIfNeeded()
  }
  const review = (name: string, open: (p: Page) => Promise<void>) =>
    reviewUi(app, page, `security pq ${name}`, { within: '[data-testid="security-pq"]', close: (p) => p.keyboard.press('Escape'), open })
  try {
    const hybrid = [{ ...OBS, kex: 'mlkem768x25519-sha256', pq: 'hybrid' as const, at: new Date().setHours(14, 5, 0, 0) }]
    const ready: PqReadiness = { ...READY, vault: { kind: 'header', version: 3, upgrade: 'done' }, transports: hybrid }
    await stubInvoke(app, 'vault:pq-readiness', ready)
    // The reported defect: the probe found the same as before, and the screen must still say it ran.
    await pq(page)
    await holdProbe(app, hybrid)
    await page.getByTestId('security-pq-check').click()
    await expect(page.getByTestId('security-pq-check')).toHaveText('Checking…')
    await releaseProbe(app)
    await expect(page.getByTestId('security-pq-check-status')).toHaveText('Checked just now')
    await expect(page.getByTestId('security-pq-check')).toHaveText('Check now')
    await page.keyboard.press('Escape')
    await review('check before', async (p) => {
      await pq(p)
      await expect(p.getByTestId('security-pq-sync')).toContainText('mlkem768x25519-sha256 · checked')
    })
    // Busy: the probe is held, so the button and the status line say what is happening.
    await holdProbe(app, hybrid)
    await review('check busy', async (p) => {
      await pq(p)
      await p.getByTestId('security-pq-check').click()
      await expect(p.getByTestId('security-pq-check')).toBeDisabled()
      await expect(p.getByTestId('security-pq-check-status')).toHaveText('Connecting to github.com…')
    })
    await stubInvoke(app, 'sync:check-transport', hybrid)
    await review('check done', async (p) => {
      await pq(p)
      await p.getByTestId('security-pq-check').click()
      await expect(p.getByTestId('security-pq-check-status')).toHaveText('Checked just now')
    })

    const waiting: Array<[string, PqReadiness['vault'], string]> = [
      ['waiting one long', waitingFor([LONG_NAME]), `Waiting for "${LONG_NAME}" to update to Slate 0.4 or newer`],
      ['waiting four', waitingFor(['Work laptop', 'Home desktop', 'nuwan-ubuntu', 'Old MacBook']), 'Waiting for 4 devices to update to Slate 0.4 or newer: "Work laptop", "Home desktop", "nuwan-ubuntu" and 1 more'],
      ['waiting sync off', { kind: 'header', version: 2, upgrade: 'waiting-devices', waiting: { reason: 'sync-off' } }, 'Waiting for sync: turn it on so Slate can check your other devices'],
    ]
    await stubInvoke(app, 'sync:check-transport', [])
    for (const [name, vault, text] of waiting) {
      await stubInvoke(app, 'vault:pq-readiness', { ...READY, vault })
      await page.keyboard.press('Escape')
      await review(name, async (p) => {
        await pq(p)
        await expect(p.getByTestId('security-pq-vault')).toContainText(text)
        await expect(p.getByTestId('security-pq-vault')).toContainText('This computer is ready.')
        if (name === 'waiting sync off') {
          await p.getByTestId('security-pq-check').click()
          await expect(p.getByTestId('security-pq-check-status')).toHaveText('Nothing to check: sync is off')
        }
      })
    }
  } finally {
    await app.close()
  }
})

/** T-PQ-D3-03: Settings → Security → Cryptographic module with the post-quantum row, in approved mode and in a development build. */
test('T-PQ-D3-03: UI: Cryptographic module post-quantum row', async () => {
  test.setTimeout(360_000)
  const { app, page } = await unlockedApp()
  try {
    const real = await page.evaluate(() => window.slate.vault.moduleStatus())
    const base: CryptoModuleStatus = { ...real, available: true, problem: null, errorState: false, postMs: 41, libcrypto: 'OpenSSL 3.5.9 30 Sep 2026', secureHeapLocked: true, pqAlgorithms: ['ML-KEM-768', 'ML-DSA-65'], pqInFipsBoundary: false }
    const states: Array<[string, CryptoModuleStatus, string]> = [
      ['approved', { ...base, approvedMode: true, development: false }, 'Not in the validated module'],
      ['development', { ...base, approvedMode: false, development: true }, 'outside the validated module'],
    ]
    for (const [name, status, text] of states) {
      await stubInvoke(app, 'vault:module-status', status)
      await page.keyboard.press('Escape')
      await reviewUi(app, page, `security module ${name}`, {
        within: '[data-testid="security-module"]',
        close: (p) => p.keyboard.press('Escape'),
        open: async (p) => {
          await openSecurity(p)
          await expect(p.getByTestId('security-module-post-quantum-algorithms')).toContainText(text)
          await p.getByTestId('security-module').scrollIntoViewIfNeeded()
        },
      })
    }
  } finally {
    await app.close()
  }
})
