import { expect, MOD, test } from '../fixtures'
import { boxWithText, moveBoxTo, rect } from '../canvasHelpers'
import { reviewUi } from './review'

const mod = MOD === 'Meta' ? 'Meta' : 'Control'

/** Two overlapping boxes: the front one's body hides the back one's text, the back one's handle shows above it. */
test('UI: canvas with overlapping boxes', async ({ app, page }) => {
  const a = await boxWithText(page, 60, 60, 'The upper box, in front.\nIts body is opaque, so the text below does not show through.')
  const b = await boxWithText(page, 60, 300, 'The lower box, behind. Its handle sits inside the upper box.')
  await moveBoxTo(page, b, a, 40, 30)
  await a.locator('.slate-box-content').click({ position: { x: 5, y: 5 } })
  await reviewUi(app, page, 'canvas overlapping boxes', {
    open: async (p) => {
      const h = await rect(b.getByTestId('box-handle'))
      await p.mouse.move(h.x + 40, h.y + 9)
      await expect(b.locator('.slate-box-bar')).toHaveCSS('opacity', '1')
    },
  })
})

test('UI: canvas with two boxes selected', async ({ app, page }) => {
  const a = await boxWithText(page, 60, 60, 'Selected box one')
  const b = await boxWithText(page, 60, 220, 'Selected box two')
  await boxWithText(page, 600, 60, 'Not selected')
  await a.getByTestId('box-handle').click({ modifiers: [mod] })
  await b.getByTestId('box-handle').click({ modifiers: [mod] })
  await expect(b).toHaveAttribute('aria-selected', 'true')
  await reviewUi(app, page, 'canvas selection')
})

test('UI: canvas context menu', async ({ app, page }) => {
  const a = await boxWithText(page, 80, 80, 'One box')
  const b = await boxWithText(page, 80, 300, 'Another box, overlapping it')
  await moveBoxTo(page, b, a, 30, 10)
  await reviewUi(app, page, 'canvas context menu', {
    open: async (p) => {
      const c = await rect(p.getByTestId('canvas'))
      await p.mouse.click(c.x + 30, c.y + 30, { button: 'right' })
      await expect(p.getByTestId('arrange-boxes')).toBeEnabled()
    },
    close: async (p) => {
      await p.keyboard.press('Escape')
      await expect(p.getByTestId('canvas-menu')).toHaveCount(0)
    },
  })
})
