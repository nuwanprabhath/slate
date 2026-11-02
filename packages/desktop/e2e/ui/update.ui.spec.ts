import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp, test } from '../fixtures'
import type { UpdateState } from '../../src/shared/api'
import { reviewUi } from './review'
import { stubEvent } from './states'

/** The update banner in each state Install and restart reaches, from a fake feed so the real banner and service run. */
async function fakeRun(mode: string, body: (app: ElectronApplication, page: Page) => Promise<void>): Promise<void> {
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_FAKE_UPDATE: mode })
  try {
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 30_000 })
    await body(app, page)
  } finally {
    await app.close()
  }
}

test('UI: update banner offers Install and restart (Ubuntu)', async () => {
  await fakeRun('deb-sudo', (app, page) => reviewUi(app, page, 'update available deb'))
})

test('UI: update banner offers Install and restart (macOS)', async () => {
  await fakeRun('dmg', (app, page) => reviewUi(app, page, 'update available dmg'))
})

test('UI: update banner asks for the password, then says it was refused', async () => {
  await fakeRun('deb-sudo', async (app, page) => {
    await reviewUi(app, page, 'update password', {
      open: async (p) => {
        if ((await p.getByTestId('update-password').count()) === 0) await p.getByTestId('update-install-restart').click()
        await expect(p.getByTestId('update-password')).toBeVisible()
      },
    })
    await reviewUi(app, page, 'update password refused', {
      open: async (p) => {
        await p.getByTestId('update-password').fill('not it')
        await p.getByTestId('update-password-submit').click()
        await expect(p.getByTestId('update-banner')).toContainText('That password was not accepted.')
        // A long typed value would not widen the field: it is a fixed-width input.
        await p.getByTestId('update-password').fill('a long password that does not fit in the field at all')
      },
    })
  })
})

test('UI: update banner after a failed install, and while restarting', async () => {
  await fakeRun('deb-installfail', async (app, page) => {
    await reviewUi(app, page, 'update install failed', {
      open: async (p) => {
        if ((await p.getByTestId('update-banner').getAttribute('data-phase')) === 'available') await p.getByTestId('update-install-restart').click()
        await expect(p.getByTestId('update-banner')).toContainText('Could not install')
      },
    })
  })
  await fakeRun('deb', async (app, page) => {
    await reviewUi(app, page, 'update restarting', {
      open: async (p) => {
        if ((await p.getByTestId('update-banner').getAttribute('data-phase')) === 'available') await p.getByTestId('update-install-restart').click()
        await expect(p.getByTestId('update-banner')).toHaveAttribute('data-phase', 'restarting')
      },
    })
  })
})

test('UI: update banner while installing, with the download progress', async () => {
  await fakeRun('deb', async (app, page) => {
    const state: UpdateState = { phase: 'downloading', kind: 'deb', version: '9.9.9', currentVersion: '0.1.0', visible: true, progress: 40, installRequested: true }
    await stubEvent(app, 'update:state-event', state)
    await reviewUi(app, page, 'update installing', { open: async (p) => expect(p.getByTestId('update-banner')).toContainText('Installing Slate 9.9.9') })
  })
})
