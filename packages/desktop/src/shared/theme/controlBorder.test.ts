import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES } from './builtins'
import { composite, contrastRatio, parseColor, type RGBA } from './color'
import { themeToCssVars } from './cssVars'
import { validateTheme } from './validate'
import type { ThemeSpec } from './spec'

const SURFACES = ['panel', 'bg', 'popover'] as const

/** The contrast of a theme's control boundary on each surface a control sits on, as the page draws them. */
function boundaryContrast(spec: ThemeSpec): Record<(typeof SURFACES)[number], number> {
  const vars = themeToCssVars(spec)
  const colour = (name: string): RGBA => {
    const c = parseColor(vars[`--${name}`] ?? '')
    expect(c, `--${name}`).not.toBeNull()
    return c!
  }
  const window = { ...colour('bg'), a: 1 }
  const boundary = colour('control-border')
  const out = { panel: 0, bg: 0, popover: 0 }
  for (const s of SURFACES) out[s] = contrastRatio(boundary, composite(colour(s), window))
  return out
}

const CUSTOM: Array<[string, unknown]> = [
  ['no palette at all', {}],
  ['a light theme with hairline borders', { palette: { bg: '#ffffff', page: '#ffffff', panel: '#f6f6f4', popover: '#ffffff', border: '#eeeeee', text: '#111111' } }],
  ['a light theme that sets no border', { palette: { bg: '#fbf7ee', panel: '#f2ecdf', popover: '#fffdf8', text: '#222222' } }],
  ['a dark theme with hairline borders', { palette: { bg: '#101014', page: '#101014', panel: '#18181d', popover: '#202027', border: '#1c1c22', text: '#eeeeee' } }],
  ['a glass theme', { material: 'glass', palette: { bg: '#141a2b', panel: '#1e2538d9', popover: '#1e2538f5', border: '#ffffff24', text: '#eef1f8' } }],
]

describe('control boundaries (WCAG 1.4.11 non-text contrast)', () => {
  for (const { spec } of BUILTIN_THEMES) {
    it(`${spec.name}: --control-border reaches 3:1 on panel, bg and popover`, () => {
      for (const [surface, ratio] of Object.entries(boundaryContrast(spec))) expect(ratio, `${spec.name} on ${surface}`).toBeGreaterThanOrEqual(3)
    })
  }

  for (const [name, input] of CUSTOM) {
    it(`a custom theme that does not set it (${name}) gets a derived --control-border at 3:1`, () => {
      const { spec } = validateTheme(input)
      for (const [surface, ratio] of Object.entries(boundaryContrast(spec))) expect(ratio, `${name} on ${surface}`).toBeGreaterThanOrEqual(3)
    })
  }

  it('a custom theme that sets a faint one has it raised to 3:1', () => {
    const { spec } = validateTheme({ palette: { bg: '#faf9f5', panel: '#f0eee6', popover: '#ffffff', 'control-border': '#e8e6dc' } })
    for (const [surface, ratio] of Object.entries(boundaryContrast(spec))) expect(ratio, surface).toBeGreaterThanOrEqual(3)
  })
})
