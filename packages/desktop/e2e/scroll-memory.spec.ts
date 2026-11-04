import { createBoxAt, expect, test } from './fixtures'

test('a page opens where it was scrolled to when you come back to it', async ({ page }) => {
  await createBoxAt(page, 100, 60)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  for (let i = 1; i <= 80; i++) await page.keyboard.type(`Line ${i}\n`)
  const scroll = page.getByTestId('canvas-scroll')
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1000)

  await scroll.evaluate((el) => el.scrollTo(0, 900))
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(900)

  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('Second')
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0)

  await page.getByTestId('page-item').filter({ hasText: 'Untitled page' }).click()
  await expect(page.getByTestId('page-title')).toHaveValue('Untitled page')
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(900)
  await expect(page.getByText('Line 60', { exact: true })).toBeInViewport()

  // The second page was never scrolled, so it still opens at the top.
  await page.getByTestId('page-item').filter({ hasText: 'Second' }).click()
  await expect(page.getByTestId('page-title')).toHaveValue('Second')
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0)
})
