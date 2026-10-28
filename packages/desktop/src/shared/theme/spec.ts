/**
 * What a theme is: data, never code.
 *
 * Every list here is an allowlist. A theme can only name things in these lists, and every value it
 * gives is checked by `validateTheme` (validate.ts) before anything uses it. The lists are also
 * what the theme generator is told it may choose from (prompt.ts builds its schema from them). A
 * new effect kind needs a draw function in `effects/index.ts` and a note in `prompt.ts`; a new
 * font a stack in `fonts.ts` and a note in `prompt.ts`. Both notes are
 * exhaustive `Record`s, so a missing one is a compile error.
 */

/** Colour tokens a theme may set: the `--name` custom properties the stylesheets read, without `--`. */
export const PALETTE_TOKENS = [
  'bg', 'page', 'panel', 'panel-2', 'toolbar-bg', 'sidebar-bg', 'popover', 'overlay',
  'box-bg', 'box-border', 'border',
  'text', 'muted', 'accent', 'accent-contrast', 'link', 'selection',
  'hover', 'selected', 'danger', 'warning', 'control-bg',
  'find-match', 'find-current', 'scrollbar-thumb',
  'code-keyword', 'code-string', 'code-number', 'code-comment', 'code-title',
] as const
export type PaletteToken = (typeof PALETTE_TOKENS)[number]

/** `glass` lets the page and panels go see-through over the window colour and its effects. */
export const MATERIALS = ['solid', 'glass'] as const
export type Material = (typeof MATERIALS)[number]

/** A still tile painted once behind the page area (textures.ts). */
export const TEXTURE_KINDS = ['none', 'paper', 'linen', 'dots', 'vellum'] as const
export type Texture = (typeof TEXTURE_KINDS)[number]

/** Animated, drawn on one canvas behind the UI (effects/). */
export const EFFECT_KINDS = ['gradient-drift', 'grain'] as const
export type EffectKind = (typeof EFFECT_KINDS)[number]

/** Font stacks: system fonts, or a family Slate bundles (fonts.ts), never one fetched from the web. */
export const FONTS = ['system', 'serif', 'humanist', 'mono', 'source-serif', 'inter'] as const
export type Font = (typeof FONTS)[number]

export interface EffectSpec {
  kind: EffectKind
  /** A palette token *name* to draw with, never a raw colour. Absent means the accent. */
  color?: PaletteToken
  intensity: number
  speed: number
  density: number
}

/** How liquid glass looks. The blur is fixed (ThemeEffects draws the back canvas small); these shape the lens. */
export interface GlassSpec {
  /** Saturation of what shows through: 1 is unchanged. */
  saturation: number
  /** 0–1: the bright rim and sheen along a pane's edges. */
  highlight: number
  /** 0–1: the lens-like band just inside a pane's edge. */
  refraction: number
}

/** The sidebar's or toolbar's own look. Gradient ends are palette token *names*, never raw colours. */
export interface SurfaceSpec {
  texture?: Exclude<Texture, 'none'>
  gradient?: { from: PaletteToken; to: PaletteToken; angle: number }
}

export const SURFACES = ['sidebar', 'toolbar'] as const
export type Surface = (typeof SURFACES)[number]

/** The palette token each surface is painted with, under its gradient or texture. */
export const SURFACE_TOKEN: Record<Surface, PaletteToken> = { sidebar: 'sidebar-bg', toolbar: 'toolbar-bg' }

export interface ThemeSpec {
  version: 1
  name: string
  palette: Partial<Record<PaletteToken, string>>
  material: Material
  texture: Texture
  effects: EffectSpec[]
  font: Font
  /** The app's UI font; absent means the platform's. */
  uiFont?: Font
  /** Only with `material: 'glass'`; absent means `DEFAULT_GLASS`. */
  glass?: GlassSpec
  surfaces?: Partial<Record<Surface, SurfaceSpec>>
}

export const DEFAULT_GLASS: GlassSpec = { saturation: 1.4, highlight: 0.5, refraction: 0.3 }

export const LIMITS = {
  saturation: { min: 0.5, max: 2 },
  angle: { min: 0, max: 360 },
  maxEffects: 2,
  maxInputChars: 65_536,
  maxNameChars: 60,
} as const

/**
 * Slate's Dark look, as colours the readability check can measure against. These mirror the
 * `:root` block in app.css; a theme that leaves a token out is shown with this value.
 */
export const DEFAULT_PALETTE: Record<PaletteToken, string> = {
  'bg': '#1e1e1e',
  'page': '#1e1e1e',
  'panel': '#252526',
  'panel-2': '#2d2d2d',
  'toolbar-bg': '#252526',
  'sidebar-bg': '#252526',
  'popover': '#2d2d2d',
  'overlay': 'rgba(0, 0, 0, 0.45)',
  'box-bg': 'rgba(0, 0, 0, 0)',
  'box-border': '#3a3a3a',
  'border': '#3a3a3a',
  'text': '#e6e6e6',
  'muted': '#9a9a9a',
  'accent': '#b48ce8',
  'accent-contrast': '#1b1325',
  'link': '#8ab4f8',
  'selection': 'rgba(180, 140, 232, 0.35)',
  'hover': '#333333',
  'selected': '#3d3d3d',
  'danger': '#e45b5b',
  'warning': '#c9a227',
  'control-bg': '#2d2d2d',
  'find-match': 'rgba(234, 92, 0, 0.33)',
  'find-current': 'rgba(255, 166, 0, 0.75)',
  'scrollbar-thumb': 'rgba(128, 128, 128, 0.4)',
  'code-keyword': '#c792ea',
  'code-string': '#c3e88d',
  'code-number': '#f78c6c',
  'code-comment': '#7f848e',
  'code-title': '#82aaff',
}

/** The look of "no theme": Dark, Slate's default. */
export const BASE_THEME: ThemeSpec = {
  version: 1,
  name: 'Dark',
  palette: {},
  material: 'solid',
  texture: 'none',
  effects: [],
  font: 'system',
}
