import type { Page } from '@playwright/test'
import { expect, MOD, test } from '../fixtures'
import { reviewUi } from './review'
import type { CryptoModuleStatus, PqReadiness } from '../../src/shared/api'
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

const OBS = { remote: 'git-ssh:github.com', transport: 'ssh', source: 'probe', at: 1 } as const
const READY: PqReadiness = { atRest: 'symmetric-256', vault: { kind: 'none' }, transports: [], updateSignature: 'ed25519', plaintextSync: false, requirePq: false }
const header = (version: 1 | 2 | 3, upgrade: 'none' | 'waiting-devices' | 'running' | 'offer-v1' | 'done', blockingDevices: string[] = []): PqReadiness['vault'] => ({ kind: 'header', version, upgrade, blockingDevices })
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
