/** Colours offered by the toolbar's colour palettes, laid out as OneNote's. */

export interface HSL {
  h: number
  s: number
  l: number
}

/** OneNote's "Standard Colours" row. */
export const STANDARD_COLORS = ['#ff6b6b', '#ff0000', '#843c0c', '#7f6000', '#38761d', '#00a651', '#0b8a8a', '#1e90ff', '#6fa8dc', '#9b59d0']

/** First row of "Theme Colours"; the rows below are shades of these. */
export const THEME_BASE = ['#1f1f1f', '#ffffff', '#595959', '#d5dce4', '#4472c4', '#ed7d31', '#e8532a', '#8a8a2e', '#b4a7d6', '#70ad47']

export function hexToHsl(hex: string): HSL {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s: s * 100, l: l * 100 }
}

export function hslToHex({ h, s, l }: HSL): string {
  const sat = s / 100
  const lum = l / 100
  const a = sat * Math.min(lum, 1 - lum)
  const f = (k: number) => {
    const t = (k + h / 30) % 12
    const v = lum - a * Math.max(-1, Math.min(t - 3, 9 - t, 1))
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/**
 * Five shades of a base, lightest first, as Office builds its theme grid: near-black bases only
 * get lighter, near-white ones only darker, and the rest get three tints and two darker shades.
 */
export function shadeColumn(base: string): string[] {
  const hsl = hexToHsl(base)
  const { l } = hsl
  const ls =
    l < 20
      ? [l + 50, l + 35, l + 25, l + 15, l + 5]
      : l > 80
        ? [l - 5, l - 15, l - 25, l - 35, l - 50]
        : [l + (100 - l) * 0.8, l + (100 - l) * 0.6, l + (100 - l) * 0.4, l * 0.75, l * 0.5]
  return ls.map((x) => hslToHex({ ...hsl, l: x }))
}

/** THEME_BASE as the first row, then one row per shade step. */
export function themeGrid(): string[][] {
  const cols = THEME_BASE.map(shadeColumn)
  return [THEME_BASE, ...[0, 1, 2, 3, 4].map((i) => cols.map((c) => c[i]!))]
}
