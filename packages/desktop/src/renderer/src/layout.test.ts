import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampWidth, COLUMN_MAX, COLUMN_MIN, fitWidth, loadLayout, saveLayout } from './layout'

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
    expect(loadLayout()).toEqual({ panelOpen: false, activeTool: 'x', sectionsWidth: null, pagesWidth: null })
  })

  it('round-trips a manual width and an auto column', () => {
    saveLayout({ panelOpen: true, activeTool: 'library', sectionsWidth: 222, pagesWidth: null })
    expect(loadLayout()).toMatchObject({ sectionsWidth: 222, pagesWidth: null })
  })
})
