import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, builtinTheme, DEFAULT_THEME_ID } from './builtins'
import { contrastRatio, parseColor, composite } from './color'
import { ALL_THEME_VARS, themeToCssVars } from './cssVars'
import { EFFECTS } from './effects'
import { resolveMotion } from './motion'
import { buildThemePrompt, extractThemeJson, THEME_JSON_SCHEMA } from './prompt'
import { resolveTheme } from './resolve'
import { DEFAULT_PALETTE, EFFECT_KINDS, type PaletteToken, type ThemeSpec } from './spec'
import { drawTexture, TEXTURES } from './textures'
import { describeReport, validateTheme } from './validate'

function recorder() {
  const calls: string[] = []
  const ctx = {
    globalAlpha: 1,
    fillStyle: '' as unknown,
    alphas: [] as number[],
    fillRect(x: number, y: number, w: number, h: number) { calls.push(`rect ${x},${y},${w},${h}`); ctx.alphas.push(ctx.globalAlpha) },
    beginPath() { calls.push('begin') },
    arc() { calls.push('arc') },
    fill() { calls.push('fill'); ctx.alphas.push(ctx.globalAlpha) },
    createRadialGradient() { return { addColorStop() {} } },
  }
  return { ctx, calls }
}

const rgba = (c: string) => parseColor(c)!

describe('validateTheme', () => {
  it('drops bad colours, unknown keys, effects and fonts, and keeps the rest', () => {
    const { spec, report } = validateTheme({
      name: 'Odd',
      palette: { text: 'url(x)', accent: '#ff0000', nope: '#fff', page: 'red; color: blue', bg: 'rgb(10, 20, 30)' },
      effects: [{ kind: 'fireworks' }, { kind: 'grain', intensity: 4 }],
      font: 'comic-sans',
      texture: 'marble',
      material: 'chrome',
      __proto__: { polluted: true },
    })
    expect(spec.palette).toMatchObject({ accent: '#ff0000ff', bg: '#0a141eff' })
    expect(Object.keys(spec.palette)).not.toContain('nope')
    expect(Object.keys(spec.palette)).not.toContain('page')
    expect(spec.effects).toEqual([{ kind: 'grain', intensity: 1, speed: 0.5, density: 0.5 }])
    expect(spec.font).toBe('system')
    expect(spec.texture).toBe('none')
    expect(spec.material).toBe('solid')
    expect(report.droppedColors).toBe(2)
    expect(report.unknown).toBeGreaterThanOrEqual(4)
    expect(report.clamped).toBe(1)
    expect(describeReport(report)).toContain('invalid colours ignored')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses non-objects and huge input with the default look', () => {
    expect(validateTheme('x').spec.palette).toEqual({})
    expect(validateTheme({ name: 'x'.repeat(70_000) }).spec.name).toBe('Dark')
    expect(validateTheme({ name: '  ' }).spec.name).toBe('Untitled theme')
  })

  it('keeps opaque what must be opaque and caps how see-through glass may go', () => {
    const solid = validateTheme({ palette: { bg: '#11223300', page: '#ffffff10' } }).spec
    expect(rgba(solid.palette.bg!).a).toBe(1)
    expect(rgba(solid.palette.page!).a).toBe(1)
    const glass = validateTheme({ material: 'glass', palette: { bg: '#11223300', page: '#20304000', popover: '#20304000' } }).spec
    expect(rgba(glass.palette.bg!).a).toBe(1)
    expect(rgba(glass.palette.page!).a).toBeGreaterThanOrEqual(0.34)
    expect(rgba(glass.palette.popover!).a).toBeGreaterThanOrEqual(0.92)
  })

  it('makes unreadable text readable', () => {
    const { spec, report } = validateTheme({ palette: { page: '#ffffff', bg: '#ffffff', text: '#eeeeee', muted: '#f0f0f0' } })
    expect(contrastRatio(rgba(spec.palette.text!), rgba('#ffffff'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(rgba(spec.palette.muted!), rgba('#ffffff'))).toBeGreaterThanOrEqual(3)
    expect(report.nudged).toBeGreaterThan(0)
  })

  it('checks text against what shows through glass and against the texture', () => {
    const { spec } = validateTheme({
      material: 'glass',
      palette: { bg: '#202020', page: '#10182040', text: '#bbbbbb', accent: '#ffffff' },
      effects: [{ kind: 'gradient-drift', color: 'accent', intensity: 1, speed: 0.2, density: 0.5 }],
      texture: 'paper',
    })
    const page = rgba(spec.palette.page!)
    const text = rgba(spec.palette.text!)
    const drift = composite({ ...rgba('#ffffff'), a: EFFECTS['gradient-drift'].maxOpacity }, rgba('#202020'))
    for (const backdrop of [rgba('#202020'), drift]) {
      const under = composite(page, backdrop)
      expect(contrastRatio(text, under)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(text, composite({ ...text, a: 0.12 }, under))).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('glass parameters and surfaces', () => {
  it('keeps glass parameters in range and drops them on solid', () => {
    const { spec, report } = validateTheme({ material: 'glass', glass: { saturation: 9, highlight: -1, refraction: 0.4, evil: 'x' } })
    expect(spec.glass).toEqual({ saturation: 2, highlight: 0, refraction: 0.4 })
    expect(report.clamped).toBe(2)
    expect(validateTheme({ material: 'solid', glass: { saturation: 1, highlight: 1, refraction: 1 } }).spec.glass).toBeUndefined()
    expect(validateTheme({ material: 'glass' }).spec.glass).toBeUndefined()
  })

  it('accepts palette-token gradients and allowlisted textures on the sidebar and toolbar', () => {
    const { spec, report } = validateTheme({
      surfaces: {
        sidebar: { texture: 'paper', gradient: { from: 'sidebar-bg', to: 'panel', angle: 400 } },
        toolbar: { texture: 'marble' },
        footer: { texture: 'paper' },
      },
    })
    expect(spec.surfaces).toEqual({ sidebar: { texture: 'paper', gradient: { from: 'sidebar-bg', to: 'panel', angle: 360 } } })
    expect(report.clamped).toBe(1)
    expect(report.unknown).toBeGreaterThanOrEqual(1)
  })

  it('refuses raw colours in a gradient', () => {
    const { spec, report } = validateTheme({ surfaces: { sidebar: { gradient: { from: '#ff0000', to: 'url(x)', angle: 90 } } } })
    expect(spec.surfaces).toBeUndefined()
    expect(report.unknown).toBeGreaterThanOrEqual(1)
  })

  it('makes sidebar text readable against both ends of its gradient', () => {
    const { spec } = validateTheme({
      palette: { 'bg': '#ffffff', 'sidebar-bg': '#ffffff', 'page': '#ffffff', 'panel': '#ffffff', 'border': '#b0b0b0', 'text': '#6a6a6a', 'muted': '#888888' },
      surfaces: { sidebar: { gradient: { from: 'sidebar-bg', to: 'border', angle: 180 } } },
    })
    const text = rgba(spec.palette.text!)
    const ends = [rgba(spec.palette['sidebar-bg']!), rgba(spec.palette.border!)]
    for (const end of ends) expect(contrastRatio(text, end)).toBeGreaterThanOrEqual(4.5)
  })

  it('turns glass and surfaces into allowlisted CSS', () => {
    const vars = themeToCssVars(builtinTheme('builtin:glass')!.spec)
    expect(vars['--glass-rim']).toContain('inset')
    expect(vars['--glass-sheen']).toContain('linear-gradient')
    const folio = themeToCssVars(builtinTheme('builtin:folio')!.spec)
    expect(folio['--sidebar-gradient']).toMatch(/^linear-gradient\(\d+deg, #[0-9a-f]{8}, #[0-9a-f]{8}\)$/)
    for (const k of [...Object.keys(vars), ...Object.keys(folio)]) expect(ALL_THEME_VARS).toContain(k)
  })

  it('tells the generator about surfaces and glass', () => {
    const schema = JSON.stringify(THEME_JSON_SCHEMA)
    expect(schema).toContain('surfaces')
    expect(schema).toContain('refraction')
    expect(buildThemePrompt({ request: 'x', current: null })).toContain('surfaces')
  })
})

describe('built-in themes', () => {
  it('has Dark (the default), Light, Glass, Paper and two more', () => {
    expect(DEFAULT_THEME_ID).toBe('builtin:dark')
    expect(BUILTIN_THEMES.map((b) => b.id)).toEqual(['builtin:dark', 'builtin:light', 'builtin:glass', 'builtin:paper', 'builtin:solarized-light', 'builtin:nord', 'builtin:folio', 'builtin:folio-dark'])
    expect(builtinTheme('builtin:glass')?.spec.material).toBe('glass')
    expect(builtinTheme('builtin:paper')?.spec.texture).toBe('paper')
  })

  it('ships Liquid Glass under the old Glass id, with lens parameters', () => {
    const glass = builtinTheme('builtin:glass')!.spec
    expect(glass.name).toBe('Liquid Glass')
    expect(glass.glass?.highlight).toBeGreaterThan(0)
    expect(glass.glass?.refraction).toBeGreaterThan(0)
    expect(glass.glass?.saturation).toBeGreaterThan(1)
  })

  it('gives Paper a paper sidebar and Folio a serif, Inter and a soft sidebar gradient', () => {
    expect(builtinTheme('builtin:paper')!.spec.surfaces?.sidebar?.texture).toBe('paper')
    for (const id of ['builtin:folio', 'builtin:folio-dark']) {
      const folio = builtinTheme(id)!.spec
      expect(folio.font).toBe('source-serif')
      expect(folio.uiFont).toBe('inter')
      expect(folio.surfaces?.sidebar?.gradient).toBeDefined()
    }
    expect(builtinTheme('builtin:folio')!.spec.palette.bg).toBe('#faf9f5ff')
    expect(builtinTheme('builtin:folio')!.spec.palette.accent).toBe('#c15c39ff')
    expect(builtinTheme('builtin:folio-dark')!.spec.palette.accent).toBe('#d97757ff')
  })

  for (const b of BUILTIN_THEMES) {
    it(`${b.spec.name} validates untouched and is readable`, () => {
      const { spec, report } = validateTheme(b.spec)
      expect(spec).toEqual(b.spec)
      expect(report).toEqual({ droppedColors: 0, clamped: 0, unknown: 0, nudged: 0 })
      const col = (t: PaletteToken) => rgba(spec.palette[t] ?? DEFAULT_PALETTE[t])
      const bg = col('bg')
      for (const surface of ['page', 'panel', 'sidebar-bg', 'toolbar-bg', 'popover'] as PaletteToken[]) {
        const under = composite(col(surface), bg)
        expect(contrastRatio(col('text'), under), `${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(col('muted'), under), `${surface} muted`).toBeGreaterThanOrEqual(3)
      }
    })
  }
})

describe('themeToCssVars', () => {
  it('sets only allowlisted custom properties, with values Slate formatted', () => {
    const spec = validateTheme({ palette: { accent: '#00ff00' }, font: 'serif' }).spec
    const vars = themeToCssVars(spec)
    expect(vars['--accent']).toBe('#00ff00ff')
    for (const k of Object.keys(vars)) expect(ALL_THEME_VARS).toContain(k)
    for (const v of Object.values(vars)) expect(v).not.toMatch(/[;{}]/)
  })
  it('fills every palette token so a theme replaces the whole look', () => {
    const vars = themeToCssVars(builtinTheme('builtin:light')!.spec)
    expect(vars['--bg']).toBeDefined()
    expect(vars['--page']).toBeDefined()
    expect(vars['--code-keyword']).toBeDefined()
  })
})

describe('effects and textures', () => {
  for (const kind of EFFECT_KINDS) {
    it(`${kind} draws within its opacity cap and is deterministic`, () => {
      const a = recorder()
      const b = recorder()
      const p = { intensity: 1, speed: 0.5, density: 0.5, color: '#ff0000' }
      EFFECTS[kind].draw(a.ctx, { t: 3, w: 200, h: 100, still: false }, p)
      EFFECTS[kind].draw(b.ctx, { t: 3, w: 200, h: 100, still: false }, p)
      expect(a.calls.length).toBeGreaterThan(0)
      expect(a.calls).toEqual(b.calls)
      for (const alpha of a.ctx.alphas) expect(alpha).toBeLessThanOrEqual(EFFECTS[kind].maxOpacity)
      expect(a.ctx.globalAlpha).toBe(1)
    })
  }
  it('gradient drift moves over time', () => {
    const at = (t: number) => {
      const r = recorder()
      const centres: number[] = []
      r.ctx.createRadialGradient = ((x: number) => { centres.push(x); return { addColorStop() {} } }) as never
      EFFECTS['gradient-drift'].draw(r.ctx, { t, w: 200, h: 100, still: false }, { intensity: 1, speed: 1, density: 0.5, color: '#fff' })
      return centres
    }
    expect(at(0)).not.toEqual(at(20))
  })
  for (const kind of TEXTURES) {
    it(`the ${kind} texture tile draws faintly`, () => {
      const r = recorder()
      drawTexture(kind, r.ctx, 128, '#000000')
      expect(r.calls.length).toBeGreaterThan(0)
      for (const alpha of r.ctx.alphas) expect(alpha).toBeLessThanOrEqual(0.12)
    })
  }
})

describe('motion and resolution', () => {
  it('resolves the motion setting', () => {
    expect(resolveMotion('auto', false, true)).toBe('full')
    expect(resolveMotion('auto', true, true)).toBe('reduced')
    expect(resolveMotion('auto', false, false)).toBe('reduced')
    expect(resolveMotion('full', true, false)).toBe('full')
    expect(resolveMotion('reduced', false, true)).toBe('reduced')
  })
  it('resolves the active theme, following the system or safe mode when asked', () => {
    const saved = [{ id: 'user:1', name: 'Mine', prompt: null, createdAt: 1, spec: { ...builtinTheme('builtin:nord')!.spec, name: 'Mine' } }]
    expect(resolveTheme({ themeId: 'user:1', saved, followSystem: false, systemDark: true, safe: false }).spec.name).toBe('Mine')
    expect(resolveTheme({ themeId: 'user:gone', saved, followSystem: false, systemDark: true, safe: false }).id).toBe('builtin:dark')
    expect(resolveTheme({ themeId: 'builtin:paper', saved, followSystem: true, systemDark: false, safe: false }).id).toBe('builtin:light')
    expect(resolveTheme({ themeId: 'builtin:paper', saved, followSystem: true, systemDark: true, safe: false }).id).toBe('builtin:dark')
    expect(resolveTheme({ themeId: 'builtin:paper', saved, followSystem: false, systemDark: true, safe: true }).id).toBe('builtin:dark')
  })
})

describe('the generator prompt', () => {
  it('asks for the allowlisted names and reads structured output back', () => {
    const schema = JSON.stringify(THEME_JSON_SCHEMA)
    expect(schema).toContain('"page"')
    expect(schema).toContain('gradient-drift')
    const current: ThemeSpec = builtinTheme('builtin:dark')!.spec
    expect(buildThemePrompt({ request: 'calm forest', current: null })).toContain('calm forest')
    expect(buildThemePrompt({ request: 'greener', current })).toContain('Adjustment requested')
    expect(extractThemeJson(JSON.stringify({ structured_output: { name: 'A' } }))).toEqual({ name: 'A' })
    expect(extractThemeJson(JSON.stringify({ result: 'Here:\n```json\n{"name":"B"}\n```' }))).toEqual({ name: 'B' })
    expect(extractThemeJson('not json')).toBeNull()
    expect(extractThemeJson(JSON.stringify({ is_error: true, result: '{}' }))).toBeNull()
  })
})
