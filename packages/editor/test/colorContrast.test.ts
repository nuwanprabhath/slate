import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor, readableColor, readableHighlight, relativeLuminance } from '../src/colorContrast'

const DARK = '#1e1e1e'
const LIGHT = '#ffffff'

describe('parseColor', () => {
  it('accepts hex, rgb(), rgba() and named colours', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#1e1e1e')).toEqual({ r: 30, g: 30, b: 30, a: 1 })
    expect(parseColor('rgb(28,29,31)')).toEqual({ r: 28, g: 29, b: 31, a: 1 })
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 })
    expect(parseColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 })
    expect(parseColor(' Black ')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    expect(parseColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })
  it('returns null for anything else', () => {
    expect(parseColor('var(--x)')).toBeNull()
    expect(parseColor('#12')).toBeNull()
    expect(parseColor('inherit')).toBeNull()
  })
})

describe('WCAG maths', () => {
  it('matches the reference values', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1)
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0)
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21)
    expect(contrastRatio('#fff', '#fff')).toBeCloseTo(1)
  })
})

describe('readableColor', () => {
  it('turns black into near-white on the dark background', () => {
    const out = readableColor('rgb(0,0,0)', DARK)
    expect(contrastRatio(out, DARK)).toBeGreaterThan(12)
  })
  it('turns dark grey into light grey', () => {
    const out = readableColor('rgb(58,56,63)', DARK)
    const c = parseColor(out)!
    expect(c.r).toBeGreaterThan(150)
    expect(contrastRatio(out, DARK)).toBeGreaterThanOrEqual(3)
  })
  it('keeps colours that already contrast', () => {
    expect(readableColor('rgb(255,0,0)', DARK)).toBe('rgb(255,0,0)')
    expect(readableColor('rgb(0,0,0)', LIGHT)).toBe('rgb(0,0,0)')
  })
  it('lightens a dark blue, keeping it blue', () => {
    const out = readableColor('rgb(18,100,163)', DARK)
    const c = parseColor(out)!
    expect(contrastRatio(out, DARK)).toBeGreaterThanOrEqual(3)
    expect(c.b).toBeGreaterThan(c.r)
  })
  it('darkens light text on the light background', () => {
    const out = readableColor('rgb(248,248,248)', LIGHT)
    expect(contrastRatio(out, LIGHT)).toBeGreaterThanOrEqual(3)
  })
  it('leaves unparseable colours alone', () => {
    expect(readableColor('var(--x)', DARK)).toBe('var(--x)')
  })
})

describe('readableHighlight', () => {
  it('darkens a light highlight behind light text', () => {
    const out = readableHighlight('#ffff00', '#e6e6e6')
    expect(contrastRatio('#e6e6e6', out)).toBeGreaterThanOrEqual(4.5)
  })
  it('keeps a highlight that already works', () => {
    expect(readableHighlight('#ffff00', '#1f1f1f')).toBe('#ffff00')
  })
})
