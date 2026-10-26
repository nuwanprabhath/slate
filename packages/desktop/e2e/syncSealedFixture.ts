import type { ElectronApplication } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Audit C8 criterion 3, ready for the maintainer's fixture: a secret sealed by the synchronous
 * `safeStorage.encryptString` of the audited (pre-C8) build opens through the async API this build
 * uses. The fixture is `{ "sealedBase64", "plain" }`, sealed on macOS by an Electron app named Slate
 * (Keychain item "Slate Safe Storage"); the C8 report says how to make it. When it lands, the
 * `it.todo` in src/main/secretStorage.test.ts becomes an e2e test here:
 *
 *   test('C8 criterion 3: …', async ({ app }) => {
 *     const { opened, plain } = await openSyncSealedFixture(app)
 *     expect(opened).toBe(plain)
 *   })
 */
export const SYNC_SEALED_FIXTURE = join(__dirname, 'fixtures', 'safe-storage-sync-sealed.json')

export async function openSyncSealedFixture(app: ElectronApplication, fixture = SYNC_SEALED_FIXTURE): Promise<{ opened: string; plain: string }> {
  const { sealedBase64, plain } = JSON.parse(readFileSync(fixture, 'utf8')) as { sealedBase64: string; plain: string }
  const opened = await app.evaluate(async ({ safeStorage }, b64) => (await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'))).result, sealedBase64)
  return { opened, plain }
}
