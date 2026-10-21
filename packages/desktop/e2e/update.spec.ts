import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'

test('the update banner offers the fake release, copies the install command and dismisses', async () => {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: 'deb' })
  try {
    const banner = page.getByTestId('update-banner')
    await expect(banner).toContainText('Slate 9.9.9 is available')
    await banner.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(banner).toContainText('Slate 9.9.9 is downloaded')

    await page.getByTestId('update-copy-command').click()
    await expect(page.getByTestId('update-copy-command')).toHaveText('Copied')
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).toMatch(/^sudo apt install '.*Slate-9\.9\.9-linux-(amd|arm)64\.deb'$/)

    await page.getByTestId('update-dismiss').click()
    await expect(banner).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('without SLATE_FAKE_UPDATE an e2e run never shows the banner', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.waitForTimeout(1000)
  await expect(page.getByTestId('update-banner')).toHaveCount(0)
})
