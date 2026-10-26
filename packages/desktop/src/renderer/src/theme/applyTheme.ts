import { setThemeColors } from '@slate/editor'
import { composite, parseColor, toHex8 } from '../../../shared/theme/color'
import { ALL_THEME_VARS, themeToCssVars } from '../../../shared/theme/cssVars'
import { resolveFonts, type FontOverride } from '../../../shared/theme/fonts'
import { DEFAULT_PALETTE, SURFACES, type PaletteToken, type Texture, type ThemeSpec } from '../../../shared/theme/spec'
import { drawTexture, TEXTURE_TILE } from '../../../shared/theme/textures'

type Listener = () => void
const listeners = new Set<Listener>()
let applied: ThemeSpec | null = null

/** The theme on the page now (a preview included): what the effects layer draws. */
export const appliedTheme = {
  get: (): ThemeSpec | null => applied,
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

const tiles = new Map<string, string>()

/** A texture as an image, drawn once per texture and ink and then reused. */
function textureTile(texture: Texture, ink: string): string | null {
  if (texture === 'none') return null
  const key = `${texture}|${ink}`
  let url = tiles.get(key)
  if (url === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = TEXTURE_TILE
    const ctx = canvas.getContext('2d')
    if (ctx === null) return null
    drawTexture(texture, ctx, TEXTURE_TILE, ink)
    url = canvas.toDataURL('image/png')
    tiles.set(key, url)
  }
  return url
}

/**
 * Puts a validated theme on the page.
 *
 * The whole mechanism is `style.setProperty` for allowlisted custom properties (cssVars.ts) plus
 * `data-material`, `data-texture` and `data-font`, whose meaning lives in themes.css. No
 * stylesheet is injected and nothing the theme wrote is parsed as CSS. The one `url()` is the
 * texture tile Slate drew itself; the fonts are stacks from fonts.ts or a validated, quoted name.
 */
export function applyTheme(spec: ThemeSpec, fonts?: FontOverride): void {
  const root = document.documentElement
  for (const name of ALL_THEME_VARS) root.style.removeProperty(name)
  for (const [name, value] of Object.entries(themeToCssVars(spec))) root.style.setProperty(name, value)
  const colour = (t: PaletteToken) => parseColor(spec.palette[t] ?? DEFAULT_PALETTE[t])!
  const page = composite(colour('page'), colour('bg'))
  const text = toHex8(colour('text'))
  const tile = textureTile(spec.texture, text)
  if (tile !== null) root.style.setProperty('--texture-image', `url("${tile}")`)
  for (const s of SURFACES) {
    const surface = spec.surfaces?.[s]
    const own = textureTile(surface?.texture ?? 'none', text)
    if (own !== null) root.style.setProperty(`--${s}-texture`, `url("${own}")`)
    // `data-sidebar-surface` / `data-toolbar-surface` say whether themes.css paints the surface's own image.
    root.dataset[`${s}Surface`] = surface === undefined ? 'plain' : 'painted'
  }
  root.dataset.material = spec.material
  root.dataset.texture = spec.texture
  root.dataset.font = spec.font
  root.dataset.uiFont = spec.uiFont ?? 'system'
  const { note, ui } = resolveFonts(spec, fonts)
  root.style.setProperty('--font-note', note)
  root.style.setProperty('--font-ui', ui)
  // Light or dark scrollbars, form controls and caret to match the page.
  const light = (0.2126 * page.r + 0.7152 * page.g + 0.0722 * page.b) / 255 > 0.5
  root.style.colorScheme = light ? 'light' : 'dark'
  setThemeColors({ background: toHex8(page), text })
  applied = spec
  listeners.forEach((l) => l())
}
