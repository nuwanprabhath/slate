import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES } from './builtins'
import { composite, contrastRatio, parseColor } from './color'
import { themeToCssVars } from './cssVars'
import { CURATED_FONTS, fontCssValue, isValidFontName, NOTE_FONT_STACKS, resolveFonts, UI_FONT_STACK } from './fonts'
import { BASE_THEME } from './spec'

describe('bundled fonts', () => {
  it('names the bundled Source Serif and Inter first', () => {
    expect(NOTE_FONT_STACKS['source-serif'].startsWith("'Source Serif 4 Variable'")).toBe(true)
    expect(NOTE_FONT_STACKS.inter.startsWith("'Inter Variable'")).toBe(true)
    expect(resolveFonts({ ...BASE_THEME, uiFont: 'inter' }, undefined).ui).toBe(NOTE_FONT_STACKS.inter)
  })
})

describe('font names', () => {
  it('accepts letters, digits, spaces, dashes, underscores and dots', () => {
    for (const n of ['Georgia', 'Iowan Old Style', 'Source Serif 4', 'JetBrains_Mono', 'Font-Name.v2']) expect(isValidFontName(n)).toBe(true)
  })

  it('rejects anything that could break out of a CSS string, and empty or over-long names', () => {
    for (const n of ['', '   ', 'a"b', "a'b", 'x;}body{color:red', 'a,b', 'url(x)', 'a\\b', 'a\nb', 'A'.repeat(81)]) expect(isValidFontName(n)).toBe(false)
  })

  it('builds a quoted family with a generic fallback', () => {
    expect(fontCssValue('Georgia')).toBe('"Georgia", serif')
    expect(fontCssValue('Fira Code Mono')).toBe('"Fira Code Mono", monospace')
    expect(fontCssValue('Some Font')).toBe('"Some Font", sans-serif')
    expect(fontCssValue('x;}body{color:red')).toBeNull()
  })

  it('expands a curated name to its stack across operating systems', () => {
    expect(fontCssValue('Inter')).toBe('"Inter Variable", "Inter", "Segoe UI", "Ubuntu", sans-serif')
    for (const f of CURATED_FONTS) {
      expect(isValidFontName(f.name)).toBe(true)
      expect(fontCssValue(f.name)).toMatch(/(serif|sans-serif|monospace|system-ui)$/)
    }
  })
})

describe('resolveFonts', () => {
  const paper = { ...BASE_THEME, font: 'serif' as const }

  it('uses the override, then the theme, then the default', () => {
    expect(resolveFonts(paper, { note: 'Georgia', ui: 'Menlo' })).toEqual({ note: '"Georgia", serif', ui: fontCssValue('Menlo') })
    expect(resolveFonts(paper, undefined)).toEqual({ note: NOTE_FONT_STACKS.serif, ui: UI_FONT_STACK })
    expect(resolveFonts(BASE_THEME, {})).toEqual({ note: NOTE_FONT_STACKS.system, ui: UI_FONT_STACK })
  })

  it('ignores an invalid override', () => {
    expect(resolveFonts(paper, { note: 'a"b' }).note).toBe(NOTE_FONT_STACKS.serif)
  })
})

describe('control tokens', () => {
  it('every built-in sets a readable control background', () => {
    for (const { spec } of BUILTIN_THEMES) {
      const vars = themeToCssVars(spec)
      const window = parseColor(vars['--bg']!)!
      const panel = composite(parseColor(vars['--panel']!)!, window)
      const control = composite(parseColor(vars['--control-bg']!)!, panel)
      expect(contrastRatio(parseColor(vars['--text']!)!, control), spec.name).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(parseColor(vars['--accent']!)!, control), spec.name).toBeGreaterThanOrEqual(3)
    }
  })

  it('a theme without a control background falls back to its panel-2', () => {
    expect(themeToCssVars({ ...BASE_THEME, palette: { 'panel-2': '#123456ff' } })['--control-bg']).toBe('#123456ff')
  })
})
