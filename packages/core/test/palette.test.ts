import { describe, expect, it } from 'vitest'
import { hexToHsl, hslToHex, shadeColumn, themeGrid, THEME_BASE, STANDARD_COLORS } from '../src/palette'

describe('palette', () => {
  it('round-trips hex through HSL', () => {
    for (const hex of ['#000000', '#ffffff', '#ff0000', '#1e90ff', '#7f6000']) expect(hslToHex(hexToHsl(hex))).toBe(hex)
  })

  it('makes five shades per base, each different from the base and from each other', () => {
    const col = shadeColumn('#4472c4')
    expect(col).toHaveLength(5)
    expect(new Set([...col, '#4472c4']).size).toBe(6)
    for (const c of col) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('lightens dark bases and darkens light ones', () => {
    const l = (hex: string) => hexToHsl(hex).l
    for (const c of shadeColumn('#000000')) expect(l(c)).toBeGreaterThan(0)
    for (const c of shadeColumn('#ffffff')) expect(l(c)).toBeLessThan(100)
  })

  it('orders mid-tone shades from lightest to darkest', () => {
    const ls = shadeColumn('#4472c4').map((c) => hexToHsl(c).l)
    expect([...ls].sort((a, b) => b - a)).toEqual(ls)
    expect(ls[0]).toBeGreaterThan(hexToHsl('#4472c4').l)
    expect(ls[4]).toBeLessThan(hexToHsl('#4472c4').l)
  })

  it('builds a 6×10 theme grid whose first row is the base colours', () => {
    const grid = themeGrid()
    expect(grid).toHaveLength(6)
    expect(grid[0]).toEqual(THEME_BASE)
    for (const row of grid) expect(row).toHaveLength(10)
    expect(STANDARD_COLORS).toHaveLength(10)
    expect(STANDARD_COLORS).toContain('#ff0000')
  })
})
