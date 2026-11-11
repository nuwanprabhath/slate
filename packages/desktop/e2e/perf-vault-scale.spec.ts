// D4: the responsiveness probe for a vault at scale (review finding F3). The budget spec types into a
// 200-box page in a vault of one page, so it cannot see a cost proportional to the vault. This one can:
// it fills the vault, syncs it to a local bare git repository, and then types while a sync run scans
// every document.
//
// It is red on `main` by design and is B3's end-to-end acceptance test (sync touches only documents that
// changed). Until B3 lands it is registered but not run; the measurement it makes on `main` is in
// `.agent-reports/rel-0.7.0/report-D4.md`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp, test } from './fixtures'
import { assertResponsive, measureDuringSync, seedPages, settled } from './vaultScale'

/**
 * The vault size the probe measures. The review's figure is 2,000, which this spec was run at locally: main
 * stopped answering for 64.6 s (report-D4.md). 500 is what it keeps, because it costs about two minutes end to
 * end against about five, and it already misses the 100 ms bar by a factor of ten (1,042 ms measured). Raise it
 * to 2_000 to reproduce the review's number; nothing else has to change.
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

    // The first sync carrying the seeded vault: the probe measures a later run, not this one.
    const syncStart = Date.now()
    await settled(page, 600_000)
    console.log(`first sync of the seeded vault finished in ${((Date.now() - syncStart) / 1000).toFixed(1)} s`)
  })

  test.afterAll(async () => {
    for (const app of apps.splice(0)) await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  // Red on `main`: a sync run loads and decodes every document in the vault without yielding, so the main
  // process stops answering IPC for seconds (6.7 s at 500 pages, 64.6 s at 2,000; report-D4.md). B3 makes a
  // run touch only the documents that changed; enable this then.
  test.fixme(`D4/B3: keys stay within the product budget and main answers within 100 ms while ${String(PAGES)} pages sync`, async () => {
    test.setTimeout(300_000)
    assertResponsive(await measureDuringSync(page), PAGES)
  })
})
