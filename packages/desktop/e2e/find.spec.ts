import type { Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

async function boxWith(page: Page, y: number, text: string) {
  await createBoxAt(page, 100, y)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type(text)
}

test('find in page: options, counts, navigation and closing', async ({ page }) => {
  await boxWith(page, 60, 'Foo foo food')
  await boxWith(page, 200, 'foo_bar FOO')
  await boxWith(page, 340, 'nothing')

  await page.keyboard.press(`${MOD}+f`)
  const input = page.getByTestId('find-input')
  await expect(input).toBeFocused()
  const count = page.getByTestId('find-count')

  await input.fill('foo')
  await expect(count).toHaveText('1 of 5')
  await expect(page.locator('.slate-find-match')).toHaveCount(5)
  await expect(page.locator('.slate-find-current')).toHaveCount(1)

  await page.getByTestId('find-matchCase').click()
  await expect(page.getByTestId('find-matchCase')).toHaveAttribute('aria-pressed', 'true')
  // foo, food and foo_bar: Match Case alone still matches substrings.
  await expect(count).toHaveText('1 of 3')
  await input.press('Alt+c')
  await expect(page.getByTestId('find-matchCase')).toHaveAttribute('aria-pressed', 'false')

  await page.getByTestId('find-wholeWord').click()
  await expect(count).toHaveText('1 of 3')
  await page.getByTestId('find-wholeWord').click()

  await page.getByTestId('find-regex').click()
  await input.fill('fo+d')
  await expect(count).toHaveText('1 of 1')
  await input.fill('fo+(')
  await expect(count).toHaveText('No results')
  await expect(page.getByTestId('find-input')).toHaveAttribute('aria-invalid', 'true')

  await input.press('Alt+c')
  await input.fill('Foo |o_')
  await expect(count).toHaveText('1 of 2')
  const boxes = page.getByTestId('box')
  const boxOfCurrent = () => page.locator('[data-testid="box"]:has(.slate-find-current) [data-testid="box-editor"]').textContent()
  await expect.poll(boxOfCurrent).toBe('Foo foo food')
  await input.press('Enter')
  await expect(count).toHaveText('2 of 2')
  await expect.poll(boxOfCurrent).toBe('foo_bar FOO')
  await input.press('Shift+Enter')
  await expect(count).toHaveText('1 of 2')
  await expect(boxes).toHaveCount(3)

  await input.press('Escape')
  await expect(page.getByTestId('find-bar')).toHaveCount(0)
  await expect(page.locator('.slate-find-match')).toHaveCount(0)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('nothing')
})

test('switching pages with the bar open searches the new page', async ({ page }) => {
  await boxWith(page, 60, 'alpha alpha')
  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('Second')
  await boxWith(page, 60, 'alpha beta')

  await page.keyboard.press(`${MOD}+f`)
  await page.getByTestId('find-input').fill('alpha')
  await expect(page.getByTestId('find-count')).toHaveText('1 of 1')
  await page.getByTestId('page-item').filter({ hasText: 'Untitled page' }).click()
  await expect(page.getByTestId('find-count')).toHaveText('1 of 2')
  await expect(page.locator('.slate-find-match')).toHaveCount(2)
})
