import { expect, test } from '../fixtures'
import { boxWithImage } from '../imageHelpers'
import { reviewUi } from './review'

test('UI: a clicked image with its resize handles', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = box.locator('img')
  await reviewUi(app, page, 'image with resize handles', {
    open: async (p) => {
      await img.click()
      await expect(box.locator('.slate-image-handle')).toHaveCount(4)
      await p.mouse.move(1, 1)
    },
  })
})
