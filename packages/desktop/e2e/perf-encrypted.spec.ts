// Audit C3 criterion 5 and D-8: the performance budget on an encrypted notes database, which runs on
// SQLCipher inside @slate/native in approved mode (FIPS provider loaded) with cipher_memory_security on.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test, unlockWith } from './fixtures'
import { measure } from './spec/perfMeasure'

const PASSWORD = 'e2e perf password'

test('an encrypted database in approved mode keeps the page-open and keystroke budgets', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page: lock } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
  try {
    const page = await unlockWith(app, lock, PASSWORD)
    await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 15_000 })
    const status = await page.evaluate(() => window.slate.vault.moduleStatus())
    console.log(`crypto module: approved mode ${String(status.approvedMode)}, ${status.libcrypto ?? 'no libcrypto'}`)
    await measure(page, 'Encrypted')
  } finally {
    await app.close()
  }
})
