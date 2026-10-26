import type { Font, ThemeSpec } from './spec'

/**
 * Fonts: the theme's note font, and the user's per-theme overrides for note text and the app's UI.
 *
 * A font name the user typed is never put into CSS as written: it must pass `isValidFontName`
 * (letters, digits, spaces, `-`, `_`, `.`), and `fontCssValue` quotes it and adds a generic
 * fallback, so it can only ever name a family.
 */

/** A user's choice for one theme; an absent field means the theme's own font. */
export interface FontOverride {
  note?: string
  ui?: string
}

export const MAX_FONT_NAME_CHARS = 80

/** The UI font when nothing overrides it, whatever the theme. */
export const UI_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Ubuntu, sans-serif"

/**
 * Each theme font as a stack. `source-serif` and `inter` name the families the renderer bundles
 * (@fontsource-variable, imported in main.tsx, so they work offline) first; the rest are system fonts.
 */
export const NOTE_FONT_STACKS: Record<Font, string> = {
  system: UI_FONT_STACK,
  serif: "Charter, 'Iowan Old Style', 'Palatino Linotype', Georgia, Cambria, serif",
  humanist: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Ubuntu Mono', monospace",
  'source-serif': "'Source Serif 4 Variable', 'Source Serif 4', Charter, Georgia, serif",
  inter: "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
}

type Generic = 'serif' | 'sans-serif' | 'monospace' | 'system-ui'

/**
 * Fonts offered in the picker. A name stands for a stack of families, so one choice looks alike on
 * macOS, Windows and Linux. `optional` ones are listed only when installed.
 */
export const CURATED_FONTS: ReadonlyArray<{ name: string; families: string[]; generic: Generic; optional?: boolean }> = [
  { name: 'System UI', families: ['-apple-system', 'Segoe UI', 'Ubuntu'], generic: 'system-ui' },
  { name: 'Inter', families: ['Inter Variable', 'Inter', 'Segoe UI', 'Ubuntu'], generic: 'sans-serif' },
  { name: 'Georgia', families: ['Georgia'], generic: 'serif' },
  { name: 'Charter', families: ['Charter', 'Bitstream Charter'], generic: 'serif' },
  { name: 'Iowan Old Style', families: ['Iowan Old Style'], generic: 'serif' },
  { name: 'Palatino', families: ['Palatino', 'Palatino Linotype', 'Book Antiqua'], generic: 'serif' },
  { name: 'Source Serif', families: ['Source Serif 4 Variable', 'Source Serif 4', 'Source Serif Pro'], generic: 'serif' },
  { name: 'Merriweather', families: ['Merriweather'], generic: 'serif', optional: true },
  { name: 'Menlo', families: ['Menlo', 'Consolas', 'DejaVu Sans Mono'], generic: 'monospace' },
  { name: 'JetBrains Mono', families: ['JetBrains Mono'], generic: 'monospace' },
]

const NAME = /^[A-Za-z0-9 _.-]+$/

export function isValidFontName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= MAX_FONT_NAME_CHARS && name.trim().length > 0 && NAME.test(name)
}

/** A best guess at the fallback for a family Slate does not know. */
function genericFor(name: string): Generic {
  const n = name.toLowerCase()
  if (/mono|code|consolas|menlo|courier/.test(n)) return 'monospace'
  if (/sans/.test(n)) return 'sans-serif'
  if (/serif|georgia|times|garamond|palatino|charter|iowan|merriweather|baskerville|cambria|book/.test(n)) return 'serif'
  return 'sans-serif'
}

const quote = (family: string): string => (family.startsWith('-') ? family : `"${family}"`)

/** A font name as a `font-family` value, or null for a name that is not allowed. */
export function fontCssValue(name: string): string | null {
  if (!isValidFontName(name)) return null
  const curated = CURATED_FONTS.find((f) => f.name.toLowerCase() === name.trim().toLowerCase())
  if (curated !== undefined) return [...curated.families.map(quote), curated.generic].join(', ')
  return `"${name.trim()}", ${genericFor(name)}`
}

/** The fonts to show: the override, then the theme's font, then the default. */
export function resolveFonts(spec: ThemeSpec, override: FontOverride | undefined): { note: string; ui: string } {
  const pick = (name: string | undefined): string | null => (name === undefined ? null : fontCssValue(name))
  return {
    note: pick(override?.note) ?? NOTE_FONT_STACKS[spec.font],
    ui: pick(override?.ui) ?? (spec.uiFont === undefined ? UI_FONT_STACK : NOTE_FONT_STACKS[spec.uiFont]),
  }
}

const MAX_THEMES = 200
const MAX_THEME_ID_CHARS = 100

/** The `fontOverrides` setting: a plain object, keeping only well-formed entries. */
export function sanitizeFontOverrides(v: unknown): Record<string, FontOverride> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, FontOverride> = {}
  for (const [id, entry] of Object.entries(v).slice(0, MAX_THEMES)) {
    if (id.length === 0 || id.length > MAX_THEME_ID_CHARS || entry === null || typeof entry !== 'object') continue
    const { note, ui } = entry as Record<string, unknown>
    const kept: FontOverride = {}
    if (isValidFontName(note)) kept.note = note
    if (isValidFontName(ui)) kept.ui = ui
    if (kept.note !== undefined || kept.ui !== undefined) out[id] = kept
  }
  return out
}
