import type { Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

const REPLACE_KEY = process.platform === 'darwin' ? 'Meta+Alt+f' : 'Control+h'

async function boxWith(page: Page, y: number, text: string) {
  await createBoxAt(page, 100, y)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type(text)
}

/** In text order: the DOM order of boxes follows their stacking, which a click changes. */
const boxTexts = async (page: Page) => (await page.getByTestId('box').allTextContents()).sort()

test('find bar replace: toggle, Replace, Preserve Case, Replace All as one undo step', async ({ page }) => {
  await boxWith(page, 60, 'Cat cat CAT')
  await boxWith(page, 200, 'a cat')

  await page.keyboard.press(`${MOD}+f`)
  await page.getByTestId('find-input').fill('cat')
  await expect(page.getByTestId('find-count')).toHaveText('1 of 4')
  await expect(page.getByTestId('replace-input')).toHaveCount(0)
  await page.getByTestId('find-replace-toggle').click()
  await expect(page.getByTestId('find-replace-toggle')).toHaveAttribute('aria-expanded', 'true')
  const replace = page.getByTestId('replace-input')
  await replace.fill('dog')

  await page.getByTestId('replace-preserveCase').click()
  await expect(page.getByTestId('replace-preserveCase')).toHaveAttribute('aria-pressed', 'true')
  await replace.press('Enter')
  await expect.poll(() => boxTexts(page)).toEqual(['Dog cat CAT', 'a cat'])
  await expect(page.getByTestId('find-count')).toHaveText('1 of 3')
  // The next Replace takes the match that slid into the current place.
  await page.getByTestId('replace-one').click()
  await expect.poll(() => boxTexts(page)).toEqual(['Dog dog CAT', 'a cat'])

  await replace.press(`${MOD}+Enter`)
  await expect.poll(() => boxTexts(page)).toEqual(['Dog dog DOG', 'a dog'])
  await expect(page.getByTestId('find-count')).toHaveText('No results')

  await replace.press('Escape')
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => boxTexts(page)).toEqual(['Dog dog CAT', 'a cat'])
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => boxTexts(page)).toEqual(['Dog cat CAT', 'a cat'])
})

test('the replace shortcut opens the bar with the replace field focused; regex groups expand', async ({ page }) => {
  await boxWith(page, 60, 'ann@site and bob@home')
  await page.keyboard.press(REPLACE_KEY)
  await expect(page.getByTestId('replace-input')).toBeFocused()
  await page.getByTestId('find-input').fill('(\\w+)@(\\w+)')
  await page.getByTestId('find-regex').click()
  await expect(page.getByTestId('find-count')).toHaveText('1 of 2')
  await page.getByTestId('replace-input').fill('$2: $1 ($&)')
  await page.getByTestId('replace-all').click()
  await expect.poll(() => boxTexts(page)).toEqual(['site: ann (ann@site) and home: bob (bob@home)'])
  // The toggle hides the row again; reopening keeps what was typed.
  await page.getByTestId('find-replace-toggle').click()
  await expect(page.getByTestId('replace-input')).toHaveCount(0)
  await page.getByTestId('find-replace-toggle').click()
  await expect(page.getByTestId('replace-input')).toHaveValue('$2: $1 ($&)')
})

async function newPage(page: Page, title: string, text: string) {
  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill(title)
  await boxWith(page, 60, text)
}

test('find in notes: Replace All… previews ticked matches by page and replaces across pages, one closed undone when opened', async ({ page }) => {
  await page.getByTestId('page-title').fill('One')
  await boxWith(page, 60, 'cat one')
  await newPage(page, 'Two', 'cat two cat')
  await newPage(page, 'Three', 'a Cat')

  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.getByTestId('search-input').fill('cat')
  await expect(page.getByTestId('search-summary')).toHaveText('4 results in 3 pages')
  await page.getByTestId('search-replace-toggle').click()
  await page.getByTestId('search-replace-input').fill('dog')
  await page.getByTestId('search-replace-preserveCase').click()
  await page.getByTestId('search-replace-all').click()

  const confirm = page.getByTestId('search-replace-confirm')
  await expect(confirm).toHaveText('Replace 4 in 3 pages')
  await expect(page.locator('[data-testid="search-match"] ins')).toHaveText(['dog', 'dog', 'dog', 'Dog'])
  // Unticking a page unticks its matches; ticking one match back counts it again.
  const groupTick = page.getByTestId('search-group').filter({ hasText: 'Two' }).getByRole('checkbox')
  await groupTick.uncheck()
  await expect(confirm).toHaveText('Replace 2 in 2 pages')
  await page.getByTestId('search-match').nth(1).getByRole('checkbox').check()
  await expect(groupTick).toHaveJSProperty('indeterminate', true)
  await expect(confirm).toHaveText('Replace 3 in 3 pages')
  await confirm.click()

  // The search runs again: only the unticked match is left.
  await expect(page.getByTestId('search-summary')).toHaveText('1 result in 1 page')
  await expect(confirm).toHaveCount(0)
  await expect(page.getByTestId('box')).toHaveText(['a Dog'])

  await page.getByTestId('activity-library').click()
  await page.getByTestId('page-item').filter({ hasText: 'One' }).click()
  await expect(page.getByTestId('box')).toHaveText(['dog one'])
  await page.getByTestId('box').click()
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('box')).toHaveText(['cat one'])
  await page.getByTestId('page-item').filter({ hasText: 'Two' }).click()
  await expect(page.getByTestId('box')).toHaveText(['dog two cat'])
})

test('find in notes: Cancel leaves every page as it was', async ({ page }) => {
  await boxWith(page, 60, 'cat')
  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.getByTestId('search-input').fill('cat')
  await page.getByTestId('search-replace-toggle').click()
  await page.getByTestId('search-replace-input').fill('dog')
  await page.getByTestId('search-replace-all').click()
  await page.getByTestId('search-replace-cancel').click()
  await expect(page.getByTestId('search-replace-confirm')).toHaveCount(0)
  await expect(page.getByTestId('search-summary')).toHaveText('1 result in 1 page')
  await expect(page.getByTestId('box')).toHaveText(['cat'])
})

test('find in notes: a match added after the search makes the preview stale, and the unticked match stays', async ({ page }) => {
  await boxWith(page, 60, 'keep cat, change cat')
  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.getByTestId('search-input').fill('cat')
  await expect(page.getByTestId('search-summary')).toHaveText('2 results in 1 page')
  await page.getByTestId('search-replace-toggle').click()
  await page.getByTestId('search-replace-input').fill('dog')
  await page.getByTestId('search-replace-all').click()
  await page.getByTestId('search-match').nth(0).getByRole('checkbox').uncheck()
  await expect(page.getByTestId('search-replace-confirm')).toHaveText('Replace 1 in 1 page')

  // Another "cat" before the unticked one: occurrence 1 is now the unticked "cat".
  await page.getByTestId('box').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
  await page.keyboard.type('cat ')
  await expect(page.getByTestId('box')).toHaveText(['cat keep cat, change cat'])
  await page.getByTestId('search-replace-confirm').click()

  await expect(page.getByTestId('search-notice')).toHaveText('The notes changed since the search; review again.')
  await expect(page.getByTestId('search-replace-confirm')).toHaveCount(0)
  await expect(page.getByTestId('search-summary')).toHaveText('3 results in 1 page')
  await expect(page.getByTestId('box')).toHaveText(['cat keep cat, change cat'])
})

test('find in notes: a regex preview shows what the whole block gives', async ({ page }) => {
  await boxWith(page, 60, `start ${'x'.repeat(60)} end`)
  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.getByTestId('search-regex').click()
  // The lookbehind reaches past the snippet's 40 characters of context.
  await page.getByTestId('search-input').fill('(?<=^start.{62})(end)')
  await expect(page.getByTestId('search-summary')).toHaveText('1 result in 1 page')
  await page.getByTestId('search-replace-toggle').click()
  await page.getByTestId('search-replace-input').fill('<$1>')
  await page.getByTestId('search-replace-all').click()
  await expect(page.locator('[data-testid="search-match"] ins')).toHaveText(['<end>'])
})
