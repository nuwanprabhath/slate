import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { startFakeGraph, type FakeGraph } from '../../importer/test/fakeGraph'
import { expect, launchApp, test } from './fixtures'

const RELEASES =
  '<html><head><title>Releases</title></head><body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">' +
  '<div style="position:absolute;left:48px;top:120px;width:320px"><p>Left notes</p>' +
  '<p><img src="https://graph.microsoft.com/v1.0/resources/img1/$value" data-src-type="image/png" alt="diagram" width="40" height="40" /></p></div>' +
  '<div style="position:absolute;left:520px;top:260px;width:300px"><p>Right notes</p></div>' +
  '</body></html>'
const simple = (title: string, extra = '') =>
  `<html><head><title>${title}</title></head><body data-absolute-enabled="true">` +
  `<div style="position:absolute;left:48px;top:100px;width:400px"><p>${title} text</p>${extra}</div></body></html>`
const page = (id: string, title: string, order: number, level: number, html: string) => ({ id, title, level, order, lastModified: '2026-01-01T00:00:00Z', html })

let fake: FakeGraph
let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  fake = await startFakeGraph({
    notebooks: [
      {
        id: 'nb-work',
        name: 'Work',
        sections: [{ id: 'sec-ad', name: 'AD', pages: [page('ad-1', 'Directory', 1, 0, simple('Directory'))] }],
        sectionGroups: [
          {
            id: 'grp-projects',
            name: 'Projects',
            sectionGroups: [],
            sections: [
              {
                id: 'sec-tern',
                name: 'TERN',
                pages: [
                  page('t-1', 'Releases', 1, 0, RELEASES),
                  page('t-2', 'Hot fixes', 2, 1, simple('Hot fixes')),
                  page('t-3', 'Old', 3, 0, simple('Old', '<object data-attachment="report.pdf" data="https://graph.microsoft.com/v1.0/resources/doc1/$value" type="application/pdf"></object>')),
                ],
              },
            ],
          },
        ],
      },
    ],
  })
  ;({ app, page: win } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')), { SLATE_GRAPH_URL: fake.url, SLATE_FAKE_AUTH: '1' }))
})

test.afterAll(async () => {
  await app?.close()
  await fake?.close()
})

async function importTern(): Promise<void> {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('import-onenote')!.click())
  const dialog = win.getByTestId('import-dialog')
  await expect(dialog).toBeVisible()
  const tern = dialog.getByRole('treeitem', { name: 'TERN' })
  await tern.click()
  await expect(tern).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('treeitem', { name: 'Projects' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('treeitem', { name: 'Work' })).toHaveAttribute('aria-checked', 'mixed')
  await expect(dialog.getByRole('treeitem', { name: 'AD' })).toHaveAttribute('aria-checked', 'false')
  await dialog.getByTestId('import-start').click()
  await expect(dialog.getByTestId('import-report')).toBeVisible()
}

test('imports a OneNote section with its group, page order, levels, positions and images', async () => {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('import-onenote')!.click())
  await win.getByTestId('import-sign-in').click()
  await win.getByTestId('import-close').click()
  await expect(win.getByTestId('import-dialog')).toHaveCount(0)

  await importTern()
  const dialog = win.getByTestId('import-dialog')
  await expect(dialog.getByTestId('import-counts')).toContainText('3 imported')
  await expect(dialog.getByTestId('import-lossy')).toContainText('report.pdf')
  await dialog.getByTestId('import-done').click()
  await expect(dialog).toHaveCount(0)

  await win.getByTestId('notebook-picker').click()
  await win.getByRole('menuitem', { name: 'Work' }).click()
  await expect(win.getByTestId('notebook-picker')).toContainText('Work')
  const group = win.locator('li', { has: win.getByTestId('group-item').filter({ hasText: 'Projects' }) })
  await group.getByTestId('section-item').filter({ hasText: 'TERN' }).click()
  await expect(win.getByTestId('page-item')).toHaveText(['Releases', 'Hot fixes', 'Old'])
  await expect(win.getByTestId('page-item').filter({ hasText: 'Hot fixes' })).toHaveAttribute('data-level', '1')

  await win.getByTestId('page-item').filter({ hasText: 'Releases' }).click()
  const boxes = win.getByTestId('box')
  await expect(boxes).toHaveCount(2)
  const left = (await boxes.filter({ hasText: 'Left notes' }).boundingBox())!
  const right = (await boxes.filter({ hasText: 'Right notes' }).boundingBox())!
  expect(left.x).toBeLessThan(right.x)
  expect(left.y).toBeLessThan(right.y)
  const img = boxes.filter({ hasText: 'Left notes' }).locator('img')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)

  await importTern()
  await expect(dialog.getByTestId('import-counts')).toContainText('0 imported · 3 skipped')
  await dialog.getByTestId('import-done').click()
})
