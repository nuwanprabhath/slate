import { parseColor, toHex8 } from './color'
import { DEFAULT_PALETTE, PALETTE_TOKENS, type ThemeSpec } from './spec'

/**
 * A validated theme as CSS custom properties: the only thing a theme's colours ever do to the page.
 * Every key is from a fixed list and every value one Slate formatted itself, so nothing here can
 * carry CSS of the theme's own. Every token is set, a left-out one to its Dark value, so one theme
 * fully replaces another.
 */
export function themeToCssVars(spec: ThemeSpec): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of PALETTE_TOKENS) out[`--${t}`] = spec.palette[t] ?? toHex8(parseColor(DEFAULT_PALETTE[t])!)
  return out
}

/** Every property `themeToCssVars` (and applyTheme's texture tile) can set. */
export const ALL_THEME_VARS: readonly string[] = [...PALETTE_TOKENS.map((t) => `--${t}`), '--texture-image']
