// @product-rule no-auto-formatting (CLAUDE.md, Product rules). A guarded spec: its expectations only grow, and only the maintainer changes the rule.
import type { Page } from '@playwright/test'
import { createBoxAt, expect, test } from '../fixtures'

const editor = (page: Page) => page.locator('[data-testid="box-editor"]:focus')

async function newBox(page: Page, x = 120, y = 120) {
  await createBoxAt(page, x, y)
  await expect(editor(page)).toHaveText('')
}

test('"* " starts a bulleted list', async ({ page }) => {
  await newBox(page)
  await page.keyboard.type('* hello')
  await expect(editor(page).locator('ul > li')).toHaveText('hello')
})

test('Backspace right after the conversion restores the literal "* "', async ({ page }) => {
  await newBox(page)
  await page.keyboard.type('* ')
  await expect(editor(page).locator('ul > li')).toHaveCount(1)
  await page.keyboard.press('Backspace')
  await expect(editor(page).locator('ul')).toHaveCount(0)
  await expect(editor(page)).toHaveText('* ')
})

test('"- " does nothing while Markdown Shortcuts is off', async ({ page }) => {
  await newBox(page)
  await page.keyboard.type('- hi')
  await expect(editor(page).locator('ul')).toHaveCount(0)
  await expect(editor(page)).toHaveText('- hi')
})

test('"* " stays text when autoBullets is off', async ({ page }) => {
  await page.evaluate(() => window.slate.settings.set({ autoBullets: false }))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await newBox(page, 300, 300)
  await page.keyboard.type('* hello')
  await expect(editor(page).locator('ul')).toHaveCount(0)
  await expect(editor(page)).toHaveText('* hello')
})
