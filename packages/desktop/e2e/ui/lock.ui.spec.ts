import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { reviewUi } from './review'
import { lockedApp, reloadTo, stubInvoke } from './states'

/** The lock screen: password only, after a wrong password, the recovery key, and with Touch ID offered. */
let app: ElectronApplication
let lock: Page

test.beforeEach(async () => {
  ;({ app, lock } = await lockedApp())
})
test.afterEach(async () => {
  await app.close()
})

test('UI: lock screen, password only', async () => {
  await reviewUi(app, lock, 'lock password')
})

test('UI: lock screen after a wrong password', async () => {
  await lock.getByTestId('lock-secret').fill('not the password')
  await lock.getByTestId('lock-unlock').click()
  await expect(lock.getByTestId('lock-error')).not.toHaveText('', { timeout: 30_000 })
  await reviewUi(app, lock, 'lock error')
})

test('UI: lock screen asking for the recovery key', async () => {
  await lock.getByTestId('lock-switch').click()
  await reviewUi(app, lock, 'lock recovery key')
})

test('UI: lock screen offering Touch ID', async () => {
  const status = await lock.evaluate(() => window.slate.vault.status())
  await stubInvoke(app, 'vault:status', { ...status, quickUnlock: 'touchid' })
  await reloadTo(lock, 'lock-quick-unlock')
  await reviewUi(app, lock, 'lock touch id')
  // The reported defect: Touch ID sat left of the card's centre, narrower than Unlock above it.
  const [unlock, quick] = await Promise.all([lock.getByTestId('lock-unlock').boundingBox(), lock.getByTestId('lock-quick-unlock').boundingBox()])
  expect(quick?.width).toBe(unlock?.width)
  expect(quick?.x).toBe(unlock?.x)
})
