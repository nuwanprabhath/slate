import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { boxWithText } from './canvasHelpers'
import { clickMenu, expect, test } from './fixtures'
import { holdSaveDialog, pdfPageCount, pdfText, stubSystemPrint } from './printHelpers'

/** Where the person saves: outside the app's data folder, which the export refuses. */
const saveDir = () => mkdtempSync(join(tmpdir(), 'slate-print-out-'))

async function titled(page: Page, title: string) {
  await page.getByTestId('page-title').fill(title)
  await page.getByTestId('page-title').press('Enter')
}

test('Export Page as PDF writes the page, its title and both boxes, to the file chosen in the save dialog', async ({ app, page }) => {
  await titled(page, 'Quarterly/plan')
  await boxWithText(page, 60, 60, 'AlphaPrinted first box')
  await boxWithText(page, 420, 200, 'BravoPrinted second box')
  const out = join(saveDir(), 'exported.pdf')
  const dialog = await holdSaveDialog(app, out)
  await clickMenu(app, 'export-pdf')
  await expect.poll(dialog.asked).toMatch(/Quarterly plan\.pdf$/)
  await dialog.release()
  await expect.poll(() => existsSync(out) && readFileSync(out).length > 0, { timeout: 15_000 }).toBe(true)
  const pdf = readFileSync(out)
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  expect(pdfPageCount(pdf)).toBe(1)
  const text = pdfText(pdf)
  for (const word of ['AlphaPrinted', 'BravoPrinted', 'Quarterly']) expect(text).toContain(word)
  await expect(page.locator('html.print-page')).toHaveCount(0)
})

test('while printing, only the page shows: title, then the boxes where they are, dark on white, scaled to the paper', async ({ app, page }) => {
  await titled(page, 'Wide page')
  const left = await boxWithText(page, 40, 40, 'Left box')
  const right = await boxWithText(page, 700, 300, 'Right box, far across')
  // Left focused: its drawn caret must not print.
  await expect(page.locator('.slate-caret:visible')).not.toHaveCount(0)
  const dialog = await holdSaveDialog(app, null)
  await clickMenu(app, 'export-pdf')
  await expect(page.locator('html.print-page')).toHaveCount(1)
  await page.emulateMedia({ media: 'print' })
  try {
    for (const chrome of ['.sidebar', '.toolbar', '.title-bar', '.activity-bar', '[data-testid="page-title"]', '.slate-box-bar']) {
      for (const el of await page.locator(chrome).all()) await expect(el).toBeHidden()
    }
    await expect(page.locator('.page-print-title')).toHaveText('Wide page')
    // The drawn caret blinks, so "hidden" could catch it between blinks: it must be out of the layout.
    expect(new Set(await page.locator('.slate-caret').evaluateAll((els) => els.map((el) => getComputedStyle(el).display)))).toEqual(new Set(['none']))
    await expect(left).toBeVisible()
    await expect(right).toBeVisible()
    const box = (sel: string) => page.locator(sel).evaluate((el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())) as DOMRect)
    const scroll = await box('.slate-scroll')
    expect(scroll.width).toBeLessThanOrEqual(718.5)
    expect(scroll.width).toBeGreaterThan(700)
    // Each box keeps its place relative to the other, scaled together.
    const [l, r] = [await left.boundingBox(), await right.boundingBox()]
    expect(r!.x).toBeGreaterThan(l!.x + l!.width)
    expect(r!.y).toBeGreaterThan(l!.y)
    const colours = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.querySelector('.slate-box-content')!).color,
    }))
    expect(colours).toEqual({ body: 'rgb(255, 255, 255)', text: 'rgb(26, 26, 26)' })
  } finally {
    await page.emulateMedia({ media: null })
    await dialog.release()
  }
  await expect(page.locator('html.print-page')).toHaveCount(0)
})

test('a page taller than a sheet is split across sheets', async ({ app, page }) => {
  await boxWithText(page, 60, 60, 'TallStart')
  for (let i = 0; i < 70; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('TallEnd')
  const out = join(saveDir(), 'tall.pdf')
  const dialog = await holdSaveDialog(app, out)
  await clickMenu(app, 'export-pdf')
  await expect.poll(dialog.asked).toMatch(/\.pdf$/)
  await dialog.release()
  await expect.poll(() => existsSync(out) && readFileSync(out).length > 0, { timeout: 15_000 }).toBe(true)
  const pdf = readFileSync(out)
  expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(2)
  expect(pdfText(pdf)).toContain('TallEnd')
})

test('a PDF is not saved inside Slate\'s data folder: the person is told and nothing is written', async ({ app, page, userData }) => {
  await boxWithText(page, 60, 60, 'Refused')
  const out = join(userData, 'inside.pdf')
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { slatePrintWarned?: string[] }
    g.slatePrintWarned = []
    Object.assign(dialog, { showMessageBox: (...args: unknown[]) => (g.slatePrintWarned!.push((args[args.length - 1] as { message: string }).message), Promise.resolve({ response: 0, checkboxChecked: false })) })
  })
  const dialog = await holdSaveDialog(app, out)
  await clickMenu(app, 'export-pdf')
  await expect.poll(dialog.asked).not.toBeNull()
  await dialog.release()
  await expect.poll(() => app.evaluate(() => (globalThis as { slatePrintWarned?: string[] }).slatePrintWarned)).toEqual(['Choose a folder outside Slate’s data folder.'])
  expect(existsSync(out)).toBe(false)
})

test('a cancelled save writes nothing, and File → Print goes to the system print with backgrounds on', async ({ app, page, userData }) => {
  await boxWithText(page, 60, 60, 'Nothing saved')
  const dialog = await holdSaveDialog(app, null)
  await clickMenu(app, 'export-pdf')
  await expect.poll(dialog.asked).not.toBeNull()
  await dialog.release()
  await expect(page.locator('html.print-page')).toHaveCount(0)
  expect(existsSync(join(userData, 'Untitled page.pdf'))).toBe(false)

  const printed = await stubSystemPrint(app)
  await clickMenu(app, 'print')
  await expect.poll(printed).toEqual([{ printBackground: true }])
  await expect(page.locator('html.print-page')).toHaveCount(0)
})
