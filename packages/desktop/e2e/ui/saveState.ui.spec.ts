import { createBoxAt, expect, test } from '../fixtures'
import { reviewUi } from './review'
import { stubInvokeError, unlockedApp } from './states'

/**
 * The toolbar's save indicator (Toolbar.tsx `SaveStatus`). Nothing is drawn while writes succeed;
 * once the store refuses one, the toolbar says so beside the sync cloud and the lock, and keeps
 * saying so while the queue retries. Main's `docs:append` is made to reject at the IPC door, so the
 * renderer under review is the real one reaching a real but broken store.
 */
test('UI: the toolbar says nothing while saves are keeping up', async ({ app, page }) => {
  await createBoxAt(page, 120, 120)
  await page.keyboard.type('Saved fine')
  await expect(page.getByTestId('save-status')).toHaveCount(0)
  await reviewUi(app, page, 'save state saved')
})

test('UI: the toolbar says "Not saved, retrying" while the store rejects writes', async () => {
  const { app, page } = await unlockedApp()
  try {
    await stubInvokeError(app, 'docs:append', 'no space left on device')
    await createBoxAt(page, 120, 120)
    await page.keyboard.type('Typed while the disk is full')
    const status = page.getByTestId('save-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveText('Not saved, retrying')
    await expect(status).toHaveAttribute('title', /no space left on device/)
    await reviewUi(app, page, 'save state not saved', {
      // The retry backoff never clears the state while the store keeps rejecting, so one more
      // keystroke per pass is enough to prove the indicator survives a resize and a theme change.
      open: async (p) => {
        await p.keyboard.type('.')
        await expect(p.getByTestId('save-status')).toBeVisible()
      },
    })
  } finally {
    await app.close()
  }
})
