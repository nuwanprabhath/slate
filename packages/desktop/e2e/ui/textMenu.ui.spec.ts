import { createBoxAt, expect, MOD, test } from '../fixtures'
import { boxWithText } from '../canvasHelpers'
import { reviewUi } from './review'

test('UI: text context menu with a selection', async ({ app, page }) => {
  const box = await boxWithText(page, 80, 80, 'Select this text and right-click it')
  const editor = box.getByTestId('box-editor')
  await reviewUi(app, page, 'text context menu with a selection', {
    open: async (p) => {
      // A theme switch rebuilds the box editor, so the selection is made again each time, by keyboard.
      await editor.focus()
      await p.keyboard.press(`${MOD}+a`)
      // On the text: a right-click past the selection's end moves the caret there, as in any Mac app.
      await editor.locator('p').first().click({ button: 'right', position: { x: 40, y: 8 } })
      await expect(p.getByTestId('text-menu-copy-markdown')).toBeEnabled()
    },
    close: async (p) => {
      await p.keyboard.press('Escape')
      await expect(p.getByTestId('text-menu')).toHaveCount(0)
    },
  })
})

test('UI: text context menu without a selection', async ({ app, page }) => {
  await createBoxAt(page, 80, 80)
  const editor = page.locator('[data-testid="box-editor"]:focus')
  await expect(editor).toHaveText('')
  await reviewUi(app, page, 'text context menu without a selection', {
    open: async (p) => {
      await editor.click({ button: 'right' })
      await expect(p.getByTestId('text-menu-copy')).toBeDisabled()
    },
    close: async (p) => {
      await p.keyboard.press('Escape')
      await expect(p.getByTestId('text-menu')).toHaveCount(0)
    },
  })
})
