import type { Page } from '@playwright/test'
import { createBoxAt, expect, test } from '../fixtures'
import { reviewUi } from './review'
import { unlockedApp } from './states'

/**
 * The formatting toolbar's layout with every phase 15 button and the lock: one row in a new window
 * (1280 px), two rows at 800 px, wrapping only between groups, so no control ends up alone on a row.
 */

/** The toolbar's controls by row (their top edge), each row as its controls' test ids. */
async function rows(page: Page): Promise<string[][]> {
  return page.evaluate(() => {
    const byTop = new Map<number, string[]>()
    const controls = document.querySelectorAll<HTMLElement>('.toolbar button, .toolbar select')
    for (const el of controls) {
      if (el.closest('.style-menu, .palette-popover, .sync-popover')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      const top = Math.round(r.top + r.height / 2)
      const key = [...byTop.keys()].find((k) => Math.abs(k - top) < 8) ?? top
      byTop.set(key, [...(byTop.get(key) ?? []), el.dataset.testid ?? el.className])
    }
    return [...byTop.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids)
  })
}

async function expectRows(page: Page, atWidth: (width: number) => number) {
  const width = await page.evaluate(() => window.innerWidth)
  const found = await rows(page)
  // On a failure, what the rows had to fit in: CI's fonts differ from a Mac's.
  const room = await page.evaluate(() => {
    const groups = document.querySelector<HTMLElement>('.toolbar-groups')!
    return {
      room: groups.clientWidth,
      toolbarLeft: Math.round(document.querySelector('.toolbar')!.getBoundingClientRect().left),
      font: getComputedStyle(document.querySelector('.toolbar button')!).fontFamily,
      groups: Array.from(groups.children).map((g) => Math.round(g.getBoundingClientRect().width)),
    }
  })
  expect(found, `${JSON.stringify(found)} in ${JSON.stringify(room)}`).toHaveLength(atWidth(width))
  for (const row of found) expect(row.length, `a row with one control: ${JSON.stringify(found)}`).toBeGreaterThan(1)
}

test('UI: toolbar rows at 800 and 1280, with an editor and the lock', async () => {
  const { app, page } = await unlockedApp()
  try {
    await createBoxAt(page, 120, 120)
    await page.keyboard.type('Toolbar layout')
    await expect(page.getByTestId('tb-bold')).toBeEnabled()
    await expect(page.getByTestId('toolbar-lock')).toBeVisible()
    await reviewUi(app, page, 'toolbar rows', { open: (p) => expectRows(p, (w) => (w >= 1280 ? 1 : 2)) })
  } finally {
    await app.close()
  }
})

test('UI: toolbar with the table tools', async ({ app, page }) => {
  await createBoxAt(page, 120, 120)
  await page.getByTestId('tb-table').click()
  await expect(page.getByTestId('tb-table-tools')).toBeVisible()
  await reviewUi(app, page, 'toolbar table tools', { open: (p) => expectRows(p, (w) => (w >= 1280 ? 2 : 3)) })
})

test('UI: toolbar rows hold with a wide system font, as on Linux', async ({ app, page }) => {
  // Linux's system-ui is wider than macOS's: two rows at 800 px there broke on a 9 px margin.
  await page.addStyleTag({ content: '.toolbar, .toolbar button, .toolbar select { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' })
  await createBoxAt(page, 120, 120)
  await page.keyboard.type('Toolbar layout')
  await reviewUi(app, page, 'toolbar rows wide font', { open: (p) => expectRows(p, (w) => (w >= 1280 ? 1 : 2)) })
})
