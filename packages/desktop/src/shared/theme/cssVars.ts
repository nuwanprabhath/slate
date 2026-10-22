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
  // A theme saved before controls had a colour of their own: its raised surface, not Dark's.
  if (spec.palette['control-bg'] === undefined && spec.palette['panel-2'] !== undefined) out['--control-bg'] = spec.palette['panel-2']
  return out
}

/** Every property `themeToCssVars` (and applyTheme's texture tile and fonts) can set. */
export const ALL_THEME_VARS: readonly string[] = [...PALETTE_TOKENS.map((t) => `--${t}`), '--texture-image', '--font-note', '--font-ui']
