import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampPane, clampWidth, COLUMN_MAX, COLUMN_MIN, fitWidth, loadLayout, paneWidth, PANE_MIN, saveLayout, scaleColumns } from './layout'

describe('fitWidth', () => {
  it('is the widest name plus its chrome', () => {
    expect(fitWidth([{ text: 60, chrome: 40 }, { text: 90, chrome: 40 }, { text: 30, chrome: 70 }])).toBe(130)
  })

  it('counts a sub-page indent as chrome', () => {
    expect(fitWidth([{ text: 80, chrome: 28 + 16 * 2 }, { text: 100, chrome: 28 }])).toBe(140)
  })

  it('grows to fit a wider footer', () => {
    expect(fitWidth([{ text: 10, chrome: 40 }], 180)).toBe(180)
  })

  it('clamps to the column bounds', () => {
    expect(fitWidth([])).toBe(COLUMN_MIN)
    expect(fitWidth([{ text: 20, chrome: 20 }])).toBe(COLUMN_MIN)
    expect(fitWidth([{ text: 2000, chrome: 20 }])).toBe(COLUMN_MAX)
    expect(clampWidth(10_000)).toBe(COLUMN_MAX)
  })

  it('rounds fractional text widths up so names are not clipped', () => {
    expect(fitWidth([{ text: 100.2, chrome: 30 }])).toBe(131)
  })
})

describe('layout storage', () => {
  const store = new Map<string, string>()
  const g = globalThis as { localStorage?: unknown }
  beforeEach(() => {
    store.clear()
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
  })
  afterEach(() => delete g.localStorage)

  it('defaults to auto widths', () => {
    expect(loadLayout()).toMatchObject({ sectionsWidth: null, pagesWidth: null })
  })

  it('migrates unversioned widths to auto but keeps the other settings', () => {
    store.set('slate:layout', JSON.stringify({ panelOpen: false, activeTool: 'x', sectionsWidth: 260, pagesWidth: 300 }))
    expect(loadLayout()).toEqual({ panelOpen: false, activeTool: 'x', sectionsWidth: null, pagesWidth: null, searchWidth: null })
  })

  it('round-trips a manual width and an auto column', () => {
    saveLayout({ panelOpen: true, activeTool: 'library', sectionsWidth: 222, pagesWidth: null, searchWidth: 400 })
    expect(loadLayout()).toMatchObject({ sectionsWidth: 222, pagesWidth: null, searchWidth: 400 })
  })

  it('keeps v2 column widths and adds an automatic search width', () => {
    store.set('slate:layout', JSON.stringify({ version: 2, sectionsWidth: 260, pagesWidth: 300 }))
    expect(loadLayout()).toMatchObject({ sectionsWidth: 260, pagesWidth: 300, searchWidth: null })
  })

  it('clamps a stored search width to the pane minimum', () => {
    store.set('slate:layout', JSON.stringify({ version: 3, searchWidth: 20 }))
    expect(loadLayout().searchWidth).toBe(PANE_MIN)
  })
})

describe('side pane width', () => {
  it('matches the Library width unless a manual width is set', () => {
    expect(paneWidth(null, 420, 1400)).toBe(420)
    expect(paneWidth(350, 420, 1400)).toBe(350)
  })

  it('stays between 200 px and half the window', () => {
    expect(clampPane(50, 1400)).toBe(PANE_MIN)
    expect(clampPane(900, 1400)).toBe(700)
    expect(paneWidth(null, 900, 1000)).toBe(500)
    expect(clampPane(300, 300)).toBe(PANE_MIN)
  })

  it('scales the Library columns proportionally to fill a width', () => {
    expect(scaleColumns(100, 300, 800)).toEqual([200, 600])
    const [s, p] = scaleColumns(130, 170, 501)
    expect(s + p).toBe(501)
    expect(s).toBeCloseTo((501 * 130) / 300, 0)
  })

  it('splits evenly when nothing was measured', () => {
    expect(scaleColumns(0, 0, 400)).toEqual([200, 200])
  })
})
