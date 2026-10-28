import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createBoxAt,expect, launchApp, MOD, test } from './fixtures'

const width = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!.width

async function drag(page: Page, testId: string, dx: number) {
  const box = (await page.getByTestId(testId).boundingBox())!
  const x = box.x + box.width / 2
  // Off-centre: the collapse button sits on the middle of the line and never starts a drag.
  const y = box.y + box.height / 4
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

test('the activity bar button hides and shows the library panel', async ({ page }) => {
  await expect(page.getByTestId('activity-bar')).toBeVisible()
  await expect(page.getByTestId('activity-library')).toHaveAttribute('aria-pressed', 'true')
  const before = await width(page, 'canvas')
  await page.getByTestId('activity-library').click()
  await expect(page.getByTestId('library-panel')).toHaveCount(0)
  await expect(page.getByTestId('activity-library')).toHaveAttribute('aria-pressed', 'false')
  expect(await width(page, 'canvas')).toBeGreaterThan(before + 200)
  await page.getByTestId('activity-library').click()
  await expect(page.getByTestId('library-panel')).toHaveCount(1)
})

test('Mod+\\ toggles the panel while typing without inserting a backslash', async ({ page }) => {
  await createBoxAt(page, 100, 100)
  await expect(page.getByTestId('box-editor')).toBeFocused()
  await page.keyboard.type('hi')
  await page.keyboard.press(`${MOD}+\\`)
  await expect(page.getByTestId('library-panel')).toHaveCount(0)
  await expect(page.getByTestId('box')).toHaveText('hi')
  await page.keyboard.press(`${MOD}+\\`)
  await expect(page.getByTestId('library-panel')).toHaveCount(1)
})

async function renameFirstSection(page: Page, title: string) {
  await page.getByTestId('section-item').first().dblclick()
  await page.getByTestId('inline-rename').fill(title)
  await page.keyboard.press('Enter')
}

test('columns fit their longest name and grow when it does', async ({ page }) => {
  await renameFirstSection(page, 'A')
  await page.getByTestId('add-section').click()
  await page.getByTestId('inline-rename').fill('B')
  await page.keyboard.press('Enter')
  await expect.poll(() => width(page, 'sections-column')).toBeLessThan(160)
  const narrow = await width(page, 'sections-column')

  await renameFirstSection(page, 'A section with a really long name!!')
  await expect.poll(() => width(page, 'sections-column')).toBeGreaterThan(narrow + 100)
  // The footer still shows both buttons whole.
  await expect(page.getByTestId('add-group')).toBeInViewport({ ratio: 1 })
})

test('splitters resize, clamp, keep the manual width and double-click back to auto', async ({ page }) => {
  await renameFirstSection(page, 'A')
  await expect.poll(() => width(page, 'sections-column')).toBeLessThan(160)
  const auto = await width(page, 'sections-column')

  await drag(page, 'splitter-sections', 100)
  expect(Math.abs((await width(page, 'sections-column')) - (auto + 100))).toBeLessThanOrEqual(4)
  const manual = await width(page, 'sections-column')
  await page.getByTestId('add-page').click()
  await page.getByTestId('section-item').first().click()
  expect(await width(page, 'sections-column')).toBeCloseTo(manual, 0)

  await drag(page, 'splitter-sections', -600)
  expect(await width(page, 'sections-column')).toBeCloseTo(100, 0)
  await page.getByTestId('splitter-sections').dblclick({ position: { x: 0.5, y: 40 } })
  expect(await width(page, 'sections-column')).toBeCloseTo(auto, 0)

  await page.getByTestId('splitter-pages').focus()
  const pages = await width(page, 'pages-column')
  await page.keyboard.press('ArrowRight')
  expect(Math.abs((await width(page, 'pages-column')) - (pages + 16))).toBeLessThanOrEqual(2)
})

test('hidden panel and column widths survive a relaunch', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  const auto = await width(first.page, 'sections-column')
  await drag(first.page, 'splitter-sections', 60)
  await first.page.getByTestId('activity-library').click()
  await first.app.close()

  const second = await launchApp(userData)
  await expect(second.page.getByTestId('activity-bar')).toBeVisible()
  await expect(second.page.getByTestId('library-panel')).toHaveCount(0)
  await second.page.getByTestId('activity-library').click()
  expect(Math.abs((await width(second.page, 'sections-column')) - (auto + 60))).toBeLessThanOrEqual(4)
  await second.app.close()
})

async function hoverLine(page: Page, testId: string) {
  const box = (await page.getByTestId(testId).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

test('each library column collapses to a rail and expands to its old width', async ({ page }) => {
  await expect(page.getByTestId('collapse-sections')).toBeHidden()
  const canvas = await width(page, 'canvas')
  const sections = await width(page, 'sections-column')
  await hoverLine(page, 'splitter-sections')
  await expect(page.getByTestId('collapse-sections')).toBeVisible()
  await expect(page.getByTestId('collapse-sections')).toHaveAttribute('aria-label', 'Hide sections')
  await page.getByTestId('collapse-sections').click()
  await expect(page.getByTestId('expand-sections')).toBeVisible()
  expect(await width(page, 'sections-column')).toBeLessThanOrEqual(24)
  await expect(page.getByTestId('splitter-sections')).toHaveCount(0)
  expect(await width(page, 'canvas')).toBeGreaterThan(canvas + sections - 40)
  // The pages column is independent.
  const pagesWidth = await width(page, 'pages-column')
  await hoverLine(page, 'splitter-pages')
  await page.getByTestId('collapse-pages').click()
  expect(await width(page, 'pages-column')).toBeLessThanOrEqual(24)
  expect(await width(page, 'sections-column')).toBeLessThanOrEqual(24)
  await page.getByTestId('expand-pages').click()
  expect(Math.abs((await width(page, 'pages-column')) - pagesWidth)).toBeLessThanOrEqual(1)
  await page.getByTestId('sections-column').click()
  await expect(page.getByTestId('expand-sections')).toHaveCount(0)
  expect(Math.abs((await width(page, 'sections-column')) - sections)).toBeLessThanOrEqual(1)
})

test('a collapsed column survives a restart and resizing still works', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  try {
    await hoverLine(first.page, 'splitter-sections')
    await first.page.getByTestId('collapse-sections').click()
    await expect(first.page.getByTestId('expand-sections')).toBeVisible()
  } finally {
    await first.app.close()
  }
  const second = await launchApp(userData)
  try {
    await expect(second.page.getByTestId('expand-sections')).toBeVisible()
    expect(await width(second.page, 'sections-column')).toBeLessThanOrEqual(24)
    const before = await width(second.page, 'pages-column')
    await drag(second.page, 'splitter-pages', 60)
    await expect.poll(() => width(second.page, 'pages-column')).toBeGreaterThan(before + 40)
  } finally {
    await second.app.close()
  }
})
