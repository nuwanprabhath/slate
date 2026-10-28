import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoxAt,expect, launchApp, test } from './fixtures'

test('a new install has one notebook, section and page', async ({ page }) => {
  await expect(page.getByTestId('notebook-picker')).toContainText('My Notebook')
  await expect(page.getByTestId('section-item')).toHaveText(['Quick Notes'])
  await expect(page.getByTestId('page-item')).toHaveText(['Untitled page'])
})

test('sections and pages can be created, renamed and switched', async ({ page }) => {
  await page.getByTestId('add-section').click()
  await page.getByTestId('inline-rename').fill('Work')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('section-item')).toHaveText(['Quick Notes', 'Work'])
  await expect(page.getByTestId('page-item')).toHaveCount(1)

  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('Second')
  await expect(page.getByTestId('page-item')).toHaveText(['Untitled page', 'Second'])

  await createBoxAt(page, 100, 100)
  await expect(page.getByTestId('box-editor')).toBeFocused()
  await page.keyboard.type('on second page')
  await expect(page.getByTestId('box')).toContainText('on second page')
  await page.getByTestId('page-item').filter({ hasText: 'Untitled page' }).click()
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.getByTestId('page-item').filter({ hasText: 'Second' }).click()
  await expect(page.getByTestId('box')).toContainText('on second page')
})

test('the page title edits in place with no underline, and Escape reverts', async ({ page }) => {
  const title = page.getByTestId('page-title')
  const style = await title.evaluate((el) => {
    const s = getComputedStyle(el)
    return { border: s.borderBottomWidth, deco: s.textDecorationLine }
  })
  expect(style.border).toBe('0px')
  expect(style.deco).toBe('none')

  await title.click()
  await expect(title).toBeFocused()
  await title.press('ControlOrMeta+a')
  await page.keyboard.type('Renamed')
  await expect(page.getByTestId('page-item')).toHaveText(['Renamed'])
  await page.keyboard.press('Escape')
  await expect(title).not.toBeFocused()
  await expect(page.getByTestId('page-item')).toHaveText(['Untitled page'])

  await title.click()
  await title.press('ControlOrMeta+a')
  await page.keyboard.type('Kept')
  await page.keyboard.press('Enter')
  await expect(title).not.toBeFocused()
  await expect(page.getByTestId('page-item')).toHaveText(['Kept'])
})

test('pages reorder by drag and delete with a confirming second click', async ({ page }) => {
  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('B')
  await page.getByTestId('page-item').filter({ hasText: 'B' }).dragTo(page.getByTestId('page-item').first(), { targetPosition: { x: 10, y: 2 } })
  await expect(page.getByTestId('page-item')).toHaveText(['B', 'Untitled page'])

  await page.getByTestId('page-item').filter({ hasText: 'B' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('menuitem', { name: /Click again/ }).click()
  await expect(page.getByTestId('page-item')).toHaveText(['Untitled page'])
})

test('pages can be indented as subpages', async ({ page }) => {
  await page.getByTestId('add-page').click()
  const sub = page.getByTestId('page-item').nth(1)
  await sub.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Make subpage' }).click()
  await expect(sub).toHaveAttribute('data-level', '1')
})

test('notebooks can be created and switched; structure persists', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  await first.page.getByTestId('notebook-picker').click()
  await first.page.getByTestId('new-notebook').click()
  await first.page.getByTestId('inline-rename').fill('Climbing')
  await first.page.keyboard.press('Enter')
  await expect(first.page.getByTestId('notebook-picker')).toContainText('Climbing')
  await first.page.getByTestId('add-section').click()
  await first.page.getByTestId('inline-rename').fill('Routes')
  await first.page.keyboard.press('Enter')
  await first.page.waitForTimeout(300)
  await first.app.close()

  const second = await launchApp(userData)
  await expect(second.page.getByTestId('notebook-picker')).toContainText('Climbing')
  await expect(second.page.getByTestId('section-item')).toHaveText(['Quick Notes', 'Routes'])
  await second.app.close()
})

test('the Settings button shows a gear, not a sun', async ({ page }) => {
  await expect(page.getByTestId('activity-settings').locator('svg[data-icon="gear"]')).toBeVisible()
})
