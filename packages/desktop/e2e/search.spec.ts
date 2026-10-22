import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createBoxAt, expect, launchApp, MOD, test } from './fixtures'

async function boxWith(page: Page, y: number, text: string) {
  await createBoxAt(page, 100, y)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type(text)
}

async function openSearch(page: Page) {
  await page.keyboard.press(`${MOD}+Shift+f`)
  await expect(page.getByTestId('search-panel')).toBeVisible()
  await expect(page.getByTestId('search-input')).toBeFocused()
}

test('find in notes: scopes, remembered scope, whole word, opening a result and a fresh index', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  let page = first.page
  await boxWith(page, 60, 'alpha beta')
  await page.getByTestId('add-section').click()
  await page.getByTestId('inline-rename').fill('Two')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('section-item')).toHaveText(['Quick Notes', 'Two'])
  await boxWith(page, 60, 'alpha gamma')

  await openSearch(page)
  await expect(page.getByTestId('activity-search')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('search-input').fill('alpha')
  const summary = page.getByTestId('search-summary')
  await expect(summary).toHaveText('2 results in 2 pages')
  await expect(page.getByTestId('search-group')).toHaveCount(2)
  await expect(page.locator('[data-testid="search-match"] mark')).toHaveText(['alpha', 'alpha'])

  const scope = page.getByTestId('search-scope')
  await scope.selectOption({ label: 'Quick Notes' })
  await expect(summary).toHaveText('1 result in 1 page')

  // Closing the panel and reopening it with the shortcut keeps the section.
  await page.getByTestId('activity-search').click()
  await expect(page.getByTestId('search-panel')).toHaveCount(0)
  await openSearch(page)
  await expect(page.getByTestId('search-scope').locator('option:checked')).toHaveText('Quick Notes')
  await first.app.close()

  const second = await launchApp(userData)
  page = second.page
  // The side pane remembers it showed Search.
  await expect(page.getByTestId('search-panel')).toBeVisible()
  await openSearch(page)
  await expect(page.getByTestId('search-scope').locator('option:checked')).toHaveText('Quick Notes')
  await page.getByTestId('search-scope').selectOption('all')
  await page.getByTestId('search-input').fill('alph')
  await expect(page.getByTestId('search-summary')).toHaveText('2 results in 2 pages')
  await page.getByTestId('search-wholeWord').click()
  await expect(page.getByTestId('search-summary')).toHaveText('No results')
  await page.getByTestId('search-wholeWord').click()

  await page.getByTestId('search-regex').click()
  await page.getByTestId('search-input').fill('al(')
  await expect(page.locator('.search-input')).toHaveClass(/has-error/)
  await expect(page.getByTestId('search-match')).toHaveCount(0)
  await page.getByTestId('search-regex').click()

  // A result in the other section switches to its page and opens the find bar on the clicked match.
  await page.getByTestId('search-input').fill('gamma')
  await expect(page.getByTestId('search-summary')).toHaveText('1 result in 1 page')
  await page.getByTestId('search-match').click()
  await expect(page.getByTestId('find-bar')).toBeVisible()
  await expect(page.getByTestId('find-input')).toHaveValue('gamma')
  await expect(page.getByTestId('find-count')).toHaveText('1 of 1')
  await expect(page.locator('.slate-find-current')).toHaveText('gamma')

  // Keyboard: down from the input into the tree, Enter on a match opens it.
  await page.getByTestId('search-input').fill('alpha')
  await expect(page.getByTestId('search-summary')).toHaveText('2 results in 2 pages')
  await page.getByTestId('search-input').press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('find-input')).toHaveValue('alpha')

  // An edit made after a search is found by the next one.
  await page.getByTestId('find-close').click()
  await boxWith(page, 240, 'omega words')
  await openSearch(page)
  await expect(async () => {
    await page.getByTestId('search-input').fill('')
    await page.getByTestId('search-input').fill('omega')
    await expect(page.getByTestId('search-summary')).toHaveText('1 result in 1 page', { timeout: 1000 })
  }).toPass()
  await second.app.close()
})

test('the search input clears with its button and Escape, and has rounded corners', async ({ page }) => {
  await boxWith(page, 60, 'alpha beta')
  await openSearch(page)
  const input = page.getByTestId('search-input')
  await expect(page.getByTestId('search-clear')).toHaveCount(0)
  expect(await input.evaluate((el) => parseFloat(getComputedStyle(el.parentElement!).borderTopLeftRadius))).toBeGreaterThan(2)
  expect(await page.getByTestId('search-scope').evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(2)

  await input.fill('alpha')
  await expect(page.getByTestId('search-group')).toHaveCount(1)
  await expect(page.getByTestId('search-clear')).toHaveAttribute('aria-label', 'Clear search')
  await page.getByTestId('search-clear').click()
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  await expect(page.getByTestId('search-group')).toHaveCount(0)
  await expect(page.getByTestId('search-clear')).toHaveCount(0)

  await input.fill('alpha')
  await expect(page.getByTestId('search-group')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('search-group')).toHaveCount(0)
})

test('the side pane keeps its width across views, and the search pane resizes and remembers it', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  const canvasX = async (p: Page) => (await p.getByTestId('canvas').boundingBox())!.x
  const x0 = await canvasX(first.page)
  await first.page.getByTestId('activity-search').click()
  await expect(first.page.getByTestId('search-panel')).toBeVisible()
  expect(Math.abs((await canvasX(first.page)) - x0)).toBeLessThanOrEqual(1)
  await first.page.getByTestId('activity-library').click()
  await expect(first.page.getByTestId('library-panel')).toBeVisible()
  expect(Math.abs((await canvasX(first.page)) - x0)).toBeLessThanOrEqual(1)

  await first.page.getByTestId('activity-search').click()
  const splitter = (await first.page.getByTestId('splitter-search').boundingBox())!
  await first.page.mouse.move(splitter.x + 0.5, splitter.y + 100)
  await first.page.mouse.down()
  await first.page.mouse.move(splitter.x + 40, splitter.y + 100, { steps: 4 })
  await first.page.mouse.move(splitter.x + 80, splitter.y + 100, { steps: 4 })
  await first.page.mouse.up()
  const wide = await canvasX(first.page)
  expect(wide).toBeGreaterThan(x0 + 60)
  await first.page.getByTestId('activity-library').click()
  await expect(first.page.getByTestId('library-panel')).toBeVisible()
  expect(Math.abs((await canvasX(first.page)) - wide)).toBeLessThanOrEqual(1)
  await first.app.close()

  const second = await launchApp(userData)
  expect(Math.abs((await canvasX(second.page)) - wide)).toBeLessThanOrEqual(1)
  await second.page.getByTestId('activity-search').click()
  await expect(second.page.getByTestId('search-panel')).toBeVisible()
  expect(Math.abs((await canvasX(second.page)) - wide)).toBeLessThanOrEqual(1)

  await second.page.getByTestId('splitter-search').dblclick()
  await second.page.getByTestId('activity-library').click()
  await expect(second.page.getByTestId('library-panel')).toBeVisible()
  const afterReset = await canvasX(second.page)
  await second.page.getByTestId('activity-search').click()
  await expect(second.page.getByTestId('search-panel')).toBeVisible()
  expect(Math.abs((await canvasX(second.page)) - afterReset)).toBeLessThanOrEqual(1)
  await second.app.close()
})
