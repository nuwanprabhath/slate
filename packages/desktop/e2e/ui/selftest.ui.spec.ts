import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from '../fixtures'
import { reviewUi } from './review'

test('UI: the self-test failed screen', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_TEST_SELFTEST_CORRUPT: 'POST-AES-GCM-DEC' })
  try {
    await expect(page.getByTestId('selftest-failed')).toBeVisible({ timeout: 30_000 })
    await reviewUi(app, page, 'selftest failed')
  } finally {
    await app.close()
  }
})
