// D4: the responsiveness probe for a vault at scale (review finding F3). The budget spec types into a
// 200-box page in a vault of one page, so it cannot see a cost proportional to the vault. This one can:
// it fills the vault, syncs it to a local bare git repository, and then types while a sync run is going.
//
// It measures two different runs, because they cost two very different things (report-D4B.md):
//
// - the FIRST sync against a new remote has no cursor, so it loads and decodes every document; it blocks the
//   main process for seconds and that is a known limitation, measured here rather than hidden;
// - every later run pushes only what changed (B3), which is what the product budget applies to.
//
// Both cases are enabled. Until the two were told apart this spec measured the first sync while believing it
// measured the steady state, and stayed red after B3 landed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp, test } from './fixtures'
import { assertFirstSyncCost, assertResponsive, measureDuringSync, seedPages, settled } from './vaultScale'

/**
 * The vault size the probe measures. The review's figure is 2,000, which this spec was run at locally: the
 * first sync blocked main for 64.6 s there, the steady state for 6.0 ms (report-D4B.md). 500 is what it keeps,
 * because it costs about two minutes end to end against about five and shows the same two-order-of-magnitude
 * split. Raise it to 2_000 to reproduce the review's number; nothing else has to change.
 */
const PAGES = 500

const root = mkdtempSync(join(tmpdir(), 'slate-e2e-vault-scale-'))
const bare = join(root, 'notes.git')
const apps: ElectronApplication[] = []

test.describe.serial(`typing while a ${String(PAGES)}-page vault syncs`, () => {
  let page: Page

  test.beforeAll(async () => {
    test.setTimeout(600_000)
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare])
    // A long interval so the only syncs are the one the edit timer starts and the one this spec clicks:
    // a sync starting mid-measurement from the 30 s timer would time two overlapping runs.
    const launched = await launchApp(join(root, 'a'), { SLATE_SYNC_INTERVAL_MS: '600000' })
    apps.push(launched.app)
    page = launched.page
    await expect(page.getByTestId('canvas')).toBeVisible()

    // Git is configured on the empty vault first: its save waits for a first sync, which is cheap before
    // seeding and would otherwise push every seeded document inside a settings dialog's timeout.
    await page.getByTestId('sync-menu').click()
    await page.getByTestId('sync-settings-open').click()
    await expect(page.getByTestId('sync-settings')).toBeVisible()
    await page.getByTestId('sync-provider-git').check()
    await page.getByTestId('git-remote-url').fill(`file://${bare}`)
    await page.getByTestId('git-test').click()
    await expect(page.getByTestId('sync-check')).toContainText('Connected')
    await page.getByTestId('sync-settings-save').click()
    await expect(page.getByTestId('sync-settings')).toHaveCount(0, { timeout: 45_000 })

    // Saving closes the dialog while its first sync is still finishing. Seeding before that run ends starts a
    // second one 2 s later (AFTER_EDIT_MS) on the same clone, and the two collide on git's index.lock.
    await settled(page, 120_000)

    const t0 = Date.now()
    const seeded = await seedPages(page, PAGES)
    console.log(`seeded ${String(PAGES)} pages in ${(seeded.seedMs / 1000).toFixed(1)} s (${String(seeded.docs)} documents in the vault); step took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    // Deliberately NOT settled here: seeding has put the first sync of the seeded vault on a 2 s fuse, and the
    // case below is inside that run. The steady-state case runs after it and settles first.
  })

  test.afterAll(async () => {
    for (const app of apps.splice(0)) await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  // A known limitation, written down with a number rather than measured around: turning sync on for a vault
  // that already holds pages freezes everything the renderer asks of main until the scan is done. The ceiling
  // is a tripwire; the figure in report-D4B.md is the one this logs.
  test(`D4B: the first sync of a ${String(PAGES)}-page vault against a new remote stalls main, and typing survives it`, async () => {
    test.setTimeout(900_000)
    assertFirstSyncCost(await measureDuringSync(page, 'edit-timer'), PAGES)
  })

  // F3's acceptance test, and B3's: once the vault is on the remote, a run touches only what changed, so main
  // keeps answering within 100 ms while the user types. Red on `main` before B3 (6.7 s at 500 pages).
  test(`D4/B3: keys stay within the product budget and main answers within 100 ms while a ${String(PAGES)}-page vault syncs`, async () => {
    test.setTimeout(600_000)
    assertResponsive(await measureDuringSync(page, 'click'), PAGES)
  })
})
