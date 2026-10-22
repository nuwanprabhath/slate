/**
 * Colour values a theme may contain, and the arithmetic the readability guard needs.
 *
 * Deliberately a whitelist of numeric syntaxes, never a general CSS colour parser: colours end up
 * as custom-property values, so a keyword, `url()`, `var()` or a string with a `;` is refused.
 * What is accepted is re-serialised as `#rrggbbaa`.
 */

import { clamp } from './guards'

export interface RGBA { r: number; g: number; b: number; a: number }

const NUM = '(-?\\d+(?:\\.\\d+)?)'
const PCT = '(-?\\d+(?:\\.\\d+)?)%'
const SEP = '\\s*,\\s*'
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB = new RegExp(`^rgba?\\(\\s*${NUM}${SEP}${NUM}${SEP}${NUM}(?:${SEP}${NUM})?\\s*\\)$`, 'i')
const HSL = new RegExp(`^hsla?\\(\\s*${NUM}${SEP}${PCT}${SEP}${PCT}(?:${SEP}${NUM})?\\s*\\)$`, 'i')

export function parseColor(input: string): RGBA | null {
  if (typeof input !== 'string' || input.length > 64) return null
  const s = input.trim()
  let m = HEX.exec(s)
  if (m !== null) {
    let h = m[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  m = RGB.exec(s)
  if (m !== null) {
    const v = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)))
    if (v.some((x) => x !== undefined && !Number.isFinite(x))) return null
    return { r: clamp(v[0]!, 0, 255), g: clamp(v[1]!, 0, 255), b: clamp(v[2]!, 0, 255), a: clamp(v[3] ?? 1, 0, 1) }
  }
  m = HSL.exec(s)
  if (m !== null) {
    const v = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)))
    if (v.some((x) => x !== undefined && !Number.isFinite(x))) return null
    const { r, g, b } = hslToRgb(((v[0]! % 360) + 360) % 360, clamp(v[1]!, 0, 100), clamp(v[2]!, 0, 100))
    return { r, g, b, a: clamp(v[3] ?? 1, 0, 1) }
  }
  return null
}

export function toHex8(c: RGBA): string {
  const h = (v: number): string => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${h(c.a * 255)}`
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sat = s / 100
  const lig = l / 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = sat * Math.min(lig, 1 - lig)
  const f = (n: number): number => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 }
}

function rgbToHsl(c: RGBA): { h: number; s: number; l: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return { h: h * 60, s: s * 100, l: l * 100 }
}

/** `fg` as it actually looks over an opaque `bg`. */
export function composite(fg: RGBA, bg: RGBA): RGBA {
  const a = fg.a
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }
}

function luminance(c: RGBA): number {
  const ch = (v: number): number => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

/** WCAG 2 contrast ratio of `fg` over `bg` (translucent `fg` composited first). */
export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const solidBg = { ...bg, a: 1 }
  const a = luminance(composite(fg, solidBg))
  const b = luminance(solidBg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * The nearest colour of the same hue that reaches `min` contrast on `bg`: lightened on a dark
 * background, darkened on a light one, in 2% steps of HSL lightness. Opaque, because a
 * translucent colour's contrast depends on whatever happens to be behind it.
 */
export function nudgeForContrast(fg: RGBA, bg: RGBA, min: number): RGBA {
  const solid = composite(fg, { ...bg, a: 1 })
  if (contrastRatio(solid, bg) >= min) return solid
  const { h, s, l: start } = rgbToHsl(solid)
  // Away from the background first (lighter on dark); if the far end is reached without enough
  // contrast — white text on a mid-grey pane — the other way.
  const preferLight = luminance({ ...bg, a: 1 }) < 0.5
  for (const step of preferLight ? [2, -2] : [-2, 2]) {
    for (let l = start + step; l >= 0 && l <= 100; l += step) {
      const { r, g, b } = hslToRgb(h, s, clamp(l, 0, 100))
      const c = { r, g, b, a: 1 }
      if (contrastRatio(c, bg) >= min) return c
    }
  }
  const white = { r: 255, g: 255, b: 255, a: 1 }
  const black = { r: 0, g: 0, b: 0, a: 1 }
  return contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black
}

export function rotateHue(c: RGBA, deg: number): RGBA {
  const { h, s, l } = rgbToHsl(c)
  const { r, g, b } = hslToRgb((((h + deg) % 360) + 360) % 360, s, l)
  return { r, g, b, a: c.a }
}

export function saturate(c: RGBA, factor: number): RGBA {
  const { h, s, l } = rgbToHsl(c)
  const { r, g, b } = hslToRgb(h, clamp(s * factor, 0, 100), l)
  return { r, g, b, a: c.a }
}
