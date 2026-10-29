// PQ-B3 (roadmap §3.5, T-PQ-B3-10): a data folder from before the post-quantum header opens, upgrades itself to header
// v3 in the background after unlock (D-9, no prompt), and afterwards the password and the recovery key each open it
// with the note intact.
//
// The fixture `fixtures/pq-v2-0.3.0/` is header v2 exactly as 0.3.0 writes it. No 0.3.0 binary was at hand, so it
// was made with this branch's code before the upgrade existed in it (header v2 is unchanged since 0.3.0): a hidden
// e2e launch on an empty folder typed the note into a box (plaintext `slate.db`), then `createEncryptedDataDir`
// (vault/testVault.ts, cheap KDF) encrypted that database and returned the recovery key, saved with the password in
// `secrets.json`. It holds no sync settings: a remote's URL lives inside the encrypted database, so a committed
// bare remote could not be found again from another checkout; the remote half is T-PQ-B3-02/-06 (vault unit tests).
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp, test, unlockWith, windowAfterUnlock } from './fixtures'

const FIXTURE = join(__dirname, 'fixtures', 'pq-v2-0.3.0')
const secrets = JSON.parse(readFileSync(join(FIXTURE, 'secrets.json'), 'utf8')) as { password: string; recoveryKey: string; note: string; revision: number }
const root = mkdtempSync(join(tmpdir(), 'slate-e2e-pq-'))
const userData = join(root, 'data')
const header = () => JSON.parse(readFileSync(join(userData, 'vault.json'), 'utf8')) as { version: number; revision: number }
const launch = () => launchApp(userData, { SLATE_TEST_WEAK_KDF: '1' })

async function expectNote(page: Page): Promise<void> {
  await expect(page.getByTestId('canvas')).toContainText(secrets.note, { timeout: 30_000 })
}

let app: ElectronApplication | undefined
test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

test('T-PQ-B3-10: a 0.3.0 v2 vault upgrades to v3 after unlock; password and recovery key still open it, the note intact', async () => {
  test.setTimeout(180_000)
  cpSync(join(FIXTURE, 'data'), userData, { recursive: true })
  expect(header()).toMatchObject({ version: 2, revision: secrets.revision })

  let launched = await launch()
  app = launched.app
  await expect(launched.page.getByTestId('lock-screen')).toBeVisible()
  let notes = await unlockWith(app, launched.page, secrets.password)
  await expect
    .poll(async () => {
      const r = await notes.evaluate(() => window.slate.vault.pqReadiness())
      return r.vault.kind === 'header' ? `${r.vault.version}:${r.vault.upgrade}` : r.vault.kind
    }, { timeout: 30_000 })
    .toBe('3:done')
  expect(header()).toMatchObject({ version: 3, revision: secrets.revision + 1, pq: { kem: 'hybrid-only', minCapability: 1 } })
  await expectNote(notes)
  await app.close()

  launched = await launch()
  app = launched.app
  notes = await unlockWith(app, launched.page, secrets.password)
  await expectNote(notes)
  await app.close()

  launched = await launch()
  app = launched.app
  await launched.page.getByTestId('lock-switch').click()
  await expect(launched.page.getByTestId('lock-secret')).toHaveAttribute('placeholder', 'Recovery key')
  await launched.page.getByTestId('lock-secret').fill(secrets.recoveryKey)
  await launched.page.getByTestId('lock-unlock').click()
  notes = await windowAfterUnlock(app, launched.page)
  await expectNote(notes)
  expect(header()).toMatchObject({ version: 3, revision: secrets.revision + 1 })
  await app.close()
  app = undefined
})
