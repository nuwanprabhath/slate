import { createBoxAt, expect, MOD, test } from './fixtures'

const focusedEditor = '[data-testid="box-editor"]:focus'

test('a click shows the caret and adds no box', async ({ page }) => {
  await page.getByTestId('canvas').click({ position: { x: 200, y: 150 } })
  await expect(page.getByTestId('pending-caret')).toBeVisible()
  await page.waitForTimeout(300)
  await expect(page.getByTestId('box')).toHaveCount(0)
})

test('typing after a click makes one box at the click point', async ({ page }) => {
  const canvas = page.getByTestId('canvas')
  await canvas.click({ position: { x: 200, y: 150 } })
  await expect(page.getByTestId('pending-caret')).toBeVisible()
  await page.keyboard.type('hello')
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box-editor')).toHaveText('hello')
  await expect(page.getByTestId('pending-caret')).toHaveCount(0)
  const c = (await canvas.boundingBox())!
  const b = (await page.getByTestId('box').boundingBox())!
  expect(Math.abs(b.x - c.x - 200)).toBeLessThanOrEqual(2)
  expect(Math.abs(b.y - c.y - 150)).toBeLessThanOrEqual(2)
})

test('fast typing after a click loses no character', async ({ page }) => {
  await page.getByTestId('canvas').click({ position: { x: 120, y: 120 } })
  await expect(page.getByTestId('pending-caret')).toBeVisible()
  await page.keyboard.type('abc', { delay: 0 })
  await expect(page.getByTestId('box-editor')).toHaveText('abc')
})

test('Enter after a click makes a box starting on an empty line', async ({ page }) => {
  await page.getByTestId('canvas').click({ position: { x: 120, y: 120 } })
  await page.keyboard.press('Enter')
  await expect(page.locator(focusedEditor)).toHaveText('')
  await page.keyboard.type('x')
  await expect(page.locator(focusedEditor)).toHaveText('x')
})

test('a double-click creates a focused empty box', async ({ page }) => {
  await createBoxAt(page, 150, 150)
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.locator(focusedEditor)).toHaveText('')
})

test('clicking away from an empty box removes it', async ({ page }) => {
  await createBoxAt(page, 150, 150)
  await expect(page.locator(focusedEditor)).toHaveCount(1)
  await page.getByTestId('canvas').click({ position: { x: 300, y: 400 } })
  await expect(page.getByTestId('box')).toHaveCount(0)
})

test('clicking away from a non-empty box keeps it', async ({ page }) => {
  await createBoxAt(page, 150, 150)
  await expect(page.locator(focusedEditor)).toHaveCount(1)
  await page.keyboard.type('stay')
  await page.getByTestId('canvas').click({ position: { x: 300, y: 400 } })
  await expect(page.getByTestId('pending-caret')).toBeVisible()
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box-editor')).toHaveText('stay')
})

test('Escape clears the caret', async ({ page }) => {
  await page.getByTestId('canvas').click({ position: { x: 200, y: 150 } })
  await expect(page.getByTestId('pending-caret')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('pending-caret')).toHaveCount(0)
  await page.keyboard.type('x')
  await expect(page.getByTestId('box')).toHaveCount(0)
})

test('clicking inside a box removes the caret', async ({ page }) => {
  await createBoxAt(page, 100, 100)
  await page.keyboard.type('here')
  await page.getByTestId('canvas').click({ position: { x: 300, y: 400 } })
  await expect(page.getByTestId('pending-caret')).toBeVisible()
  await page.getByTestId('box-editor').click()
  await expect(page.getByTestId('pending-caret')).toHaveCount(0)
})

test('pasting after a click makes a box with the pasted text', async ({ app, page }) => {
  await app.evaluate(({ clipboard }) => clipboard.writeText('pasted words'))
  await page.getByTestId('canvas').click({ position: { x: 220, y: 180 } })
  await expect(page.getByTestId('pending-caret')).toBeVisible()
  await page.keyboard.press(`${MOD}+V`)
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box-editor')).toHaveText('pasted words')
  const c = (await page.getByTestId('canvas').boundingBox())!
  const b = (await page.getByTestId('box').boundingBox())!
  expect(Math.abs(b.x - c.x - 220)).toBeLessThanOrEqual(2)
})

test('Mod+Shift+V after a click pastes plain text into a new box', async ({ app, page }) => {
  await app.evaluate(({ clipboard, ClipboardItem }) =>
    clipboard.write([
      new ClipboardItem({
        'text/html': new Blob(['<b>plain only</b>'], { type: 'text/html' }),
        'text/plain': new Blob(['plain only'], { type: 'text/plain' }),
      }),
    ]),
  )
  await page.getByTestId('canvas').click({ position: { x: 220, y: 180 } })
  await page.keyboard.press(`${MOD}+Shift+V`)
  await expect(page.getByTestId('box-editor')).toHaveText('plain only')
  await expect(page.locator('[data-testid="box-editor"] strong')).toHaveCount(0)
})

test('Mod shortcuts still work while the caret shows', async ({ page }) => {
  await createBoxAt(page, 100, 100)
  await page.keyboard.type('undo me')
  await page.waitForTimeout(700)
  await page.getByTestId('canvas').click({ position: { x: 300, y: 400 } })
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('canvas')).not.toContainText('undo me')
})
