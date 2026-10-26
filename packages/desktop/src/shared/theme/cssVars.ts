import { parseColor, toHex8 } from './color'
import { DEFAULT_GLASS, DEFAULT_PALETTE, PALETTE_TOKENS, SURFACES, type PaletteToken, type ThemeSpec } from './spec'

const white = (alpha: number): string => `rgba(255, 255, 255, ${alpha.toFixed(3)})`

/**
 * Glass as CSS, as Apiary draws it: the rim and sheen the highlight asks for, and the lens edge the
 * refraction asks for. (The blur and saturation are not CSS: ThemeEffects draws the back canvas
 * already blurred and saturated, so nothing re-filters per frame.)
 */
function glassVars(spec: ThemeSpec): Record<string, string> {
  const { highlight: h, refraction: r } = spec.glass ?? DEFAULT_GLASS
  const rim = [
    `inset 0 1px 0 0 ${white(0.55 * h)}`,
    `inset 0 0 0 1px ${white(0.16 * h)}`,
    `inset 0 -1px 0 0 ${white(0.06 * h)}`,
  ]
  if (r > 0) rim.push(`inset 0 0 ${String(Math.round(8 + 16 * r))}px ${String(Math.round(r * 2))}px ${white(0.12 * r)}`)
  return {
    '--glass-rim': rim.join(', '),
    '--glass-sheen': `linear-gradient(135deg, ${white(0.14 * h)} 0%, ${white(0)} 36%, ${white(0)} 72%, ${white(0.05 * h)} 100%)`,
  }
}

/**
 * A validated theme as CSS custom properties: the only thing a theme's colours ever do to the page.
 * Every key is from a fixed list and every value one Slate formatted itself, so nothing here can
 * carry CSS of the theme's own. Every token is set, a left-out one to its Dark value, so one theme
 * fully replaces another.
 */
export function themeToCssVars(spec: ThemeSpec): Record<string, string> {
  const out: Record<string, string> = {}
  const colour = (t: PaletteToken): string => spec.palette[t] ?? toHex8(parseColor(DEFAULT_PALETTE[t])!)
  for (const t of PALETTE_TOKENS) out[`--${t}`] = colour(t)
  // A theme saved before controls had a colour of their own: its raised surface, not Dark's.
  if (spec.palette['control-bg'] === undefined && spec.palette['panel-2'] !== undefined) out['--control-bg'] = spec.palette['panel-2']
  if (spec.material === 'glass') Object.assign(out, glassVars(spec))
  for (const s of SURFACES) {
    const g = spec.surfaces?.[s]?.gradient
    if (g !== undefined) out[`--${s}-gradient`] = `linear-gradient(${String(Math.round(g.angle))}deg, ${colour(g.from)}, ${colour(g.to)})`
  }
  return out
}

/** Every property `themeToCssVars` (and applyTheme's texture tiles and fonts) can set. */
export const ALL_THEME_VARS: readonly string[] = [
  ...PALETTE_TOKENS.map((t) => `--${t}`), '--texture-image', '--font-note', '--font-ui', '--glass-rim', '--glass-sheen',
  ...SURFACES.flatMap((s) => [`--${s}-gradient`, `--${s}-texture`]),
]
