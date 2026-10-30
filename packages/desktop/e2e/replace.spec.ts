import type { Page } from '@playwright/test'
import { createBoxAt, expect, MOD, test } from './fixtures'

const REPLACE_KEY = process.platform === 'darwin' ? 'Meta+Alt+f' : 'Control+h'

async function boxWith(page: Page, y: number, text: string) {
  await createBoxAt(page, 100, y)
  await expect(page.locator('[data-testid="box-editor"]:focus')).toHaveText('')
  await page.keyboard.type(text)
}

const boxTexts = (page: Page) => page.getByTestId('box').allTextContents()

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
