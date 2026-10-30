import type { Locator, Page } from '@playwright/test'
import { rect } from './canvasHelpers'
import { expect, MOD, test } from './fixtures'
import { boxWithImage } from './imageHelpers'

const drawnWidth = (img: Locator) => img.evaluate((el) => el.getBoundingClientRect().width)

/** Drags a handle by (dx, dy) in small steps, as a hand does. */
async function dragHandle(page: Page, handle: Locator, dx: number, dy = 0): Promise<void> {
  const r = await rect(handle)
  const x = r.x + r.width / 2
  const y = r.y + r.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
}

test('a clicked image resizes from its corners, keeping its shape, as one undo step', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = box.locator('img')
  const handles = box.locator('.slate-image-handle')
  await expect(handles).toHaveCount(0)
  await img.click()
  await expect(handles).toHaveCount(4)

  // Each handle straddles a corner of the selection ring.
  const image = await rect(img)
  const se = await rect(handles.nth(3))
  expect(se.x + se.width).toBeCloseTo(image.x + image.width + 3, 0)
  expect(se.y + se.height).toBeCloseTo(image.y + image.height + 3, 0)

  await dragHandle(page, handles.nth(3), -120)
  await expect(img).toHaveAttribute('width', '120')
  expect(await rect(img)).toMatchObject({ width: 120, height: 60 })
  await expect(img).toHaveClass(/ProseMirror-selectednode/)
  await expect(handles).toHaveCount(4)

  // From the top-left corner, dragging up and left grows it.
  await dragHandle(page, handles.nth(0), -40, -10)
  await expect(img).toHaveAttribute('width', '160')

  await page.keyboard.press(`${MOD}+z`)
  await expect(img).toHaveAttribute('width', '120')
  await page.keyboard.press(`${MOD}+z`)
  await expect(img).not.toHaveAttribute('width')
  expect(await drawnWidth(img)).toBe(240)
})

test('an image resizes between 32px and the box content width; a handle double-click resets it', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = box.locator('img')
  const handles = box.locator('.slate-image-handle')
  await img.click()

  await dragHandle(page, handles.nth(3), -400)
  await expect(img).toHaveAttribute('width', '32')

  await img.click()
  await dragHandle(page, handles.nth(3), 1000)
  const content = await box.locator('.slate-box-content').evaluate((el) => {
    const s = getComputedStyle(el)
    return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
  })
  await expect(img).toHaveAttribute('width', String(Math.round(content)))

  await handles.nth(1).dblclick()
  await expect(img).not.toHaveAttribute('width')
  expect(await drawnWidth(img)).toBe(240)
  // The double-click made no new box on the canvas below.
  await expect(page.locator('[data-testid="box-editor"]')).toHaveCount(1)
})

test('a resized image keeps its width when the page is opened again', async ({ app, page }) => {
  const box = await boxWithImage(app, page)
  const img = box.locator('img')
  await img.click()
  await dragHandle(page, box.locator('.slate-image-handle').nth(3), -100)
  await expect(img).toHaveAttribute('width', '140')
  await page.reload()
  await expect(page.locator('[data-testid="box-editor"] img')).toHaveAttribute('width', '140')
})
