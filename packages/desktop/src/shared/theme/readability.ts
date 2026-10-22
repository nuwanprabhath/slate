import { parseColor, toHex8, contrastRatio, nudgeForContrast, composite, type RGBA } from './color'
import { EFFECTS } from './effects'
import { DEFAULT_PALETTE, type ThemeSpec, type PaletteToken } from './spec'
import { TEXTURE_MAX_OPACITY } from './textures'

/**
 * `validateTheme`'s readability pass, kept out of `validate.ts` so that security boundary stays
 * short enough to review. It runs only on a spec that has already been validated.
 */

export interface ThemeReport {
  /** Colour values that were not colours. */
  droppedColors: number
  /** Numbers pulled back into range, or missing and defaulted. */
  clamped: number
  /** Unknown fonts, textures, materials, effects or effect colours, and effects over the limit. */
  unknown: number
  /** Colours adjusted for readability. */
  nudged: number
}

export function emptyReport(): ThemeReport {
  return { droppedColors: 0, clamped: 0, unknown: 0, nudged: 0 }
}

const READING: PaletteToken[] = ['page', 'box-bg', 'panel', 'panel-2', 'toolbar-bg', 'sidebar-bg', 'popover', 'selected', 'hover']

/** Which colours must be readable on which surfaces, and how readable. */
const PALETTE_CONTRAST: Array<{ fg: PaletteToken; on: PaletteToken[]; min: number }> = [
  { fg: 'text', on: READING, min: 4.5 },
  { fg: 'muted', on: ['page', 'panel', 'toolbar-bg', 'sidebar-bg', 'popover'], min: 3 },
  { fg: 'accent', on: ['page', 'sidebar-bg'], min: 3 },
  { fg: 'link', on: ['page'], min: 3 },
  { fg: 'warning', on: ['page'], min: 3 },
  { fg: 'danger', on: ['panel', 'popover'], min: 3 },
  { fg: 'code-keyword', on: ['panel'], min: 3 },
  { fg: 'code-string', on: ['panel'], min: 3 },
  { fg: 'code-number', on: ['panel'], min: 3 },
  { fg: 'code-comment', on: ['panel'], min: 3 },
  { fg: 'code-title', on: ['panel'], min: 3 },
  { fg: 'accent-contrast', on: ['accent'], min: 4.5 },
]

/** What each surface is drawn on, nearest first; anything not listed sits on the window (`bg`). */
const UNDERLAYS: Partial<Record<PaletteToken, PaletteToken[]>> = {
  'box-bg': ['page'],
  'panel-2': ['panel'],
  'selected': ['sidebar-bg'],
  'hover': ['sidebar-bg', 'toolbar-bg'],
  'accent': ['page', 'panel'],
}

/**
 * What can show behind a see-through surface: the window colour, and the window with each effect's
 * colour painted over it at the most opaque that effect ever paints.
 */
function backdrops(spec: ThemeSpec, resolved: (t: PaletteToken) => RGBA): RGBA[] {
  const win = { ...resolved('bg'), a: 1 }
  const out = [win]
  for (const e of spec.effects) {
    const alpha = EFFECTS[e.kind].maxOpacity * e.intensity
    const c = resolved(e.color ?? 'accent')
    out.push(composite({ ...c, a: alpha * c.a }, win))
  }
  return out
}

function unique(colours: RGBA[]): RGBA[] {
  const seen = new Set<string>()
  return colours.filter((v) => {
    const k = toHex8(v)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Every opaque colour `token` can end up looking like: itself over each thing it can sit on, down
 * to the window (`under`, the backdrops), and on the page also with the texture's ink over it.
 */
function looks(spec: ThemeSpec, token: PaletteToken, resolved: (t: PaletteToken) => RGBA, under: RGBA[]): RGBA[] {
  if (token === 'bg') return under
  const c = resolved(token)
  const base = c.a >= 1 ? [c] : unique((UNDERLAYS[token] ?? ['bg']).flatMap((u) => looks(spec, u, resolved, under)).map((u) => composite(c, u)))
  if (token !== 'page' || spec.texture === 'none') return base
  const ink = resolved('text')
  return unique([...base, ...base.map((b) => composite({ ...ink, a: TEXTURE_MAX_OPACITY }, b))])
}

/**
 * Fixes readability in place. Only a pair the theme itself touched is checked; a default it never
 * mentioned is readable by design.
 *
 * On a see-through surface a colour is readable only if it is readable over everything that can
 * show through. The text is first fitted to the usual case (the surface over the window colour);
 * then any surface that still lets something unreadable through is made more opaque, step by
 * step; and only a surface that is fully opaque and still fails moves the text again.
 */
export function ensureReadable(spec: ThemeSpec, report: ThemeReport): void {
  const resolved = (t: PaletteToken): RGBA => parseColor(spec.palette[t] ?? DEFAULT_PALETTE[t])!
  const behind = backdrops(spec, resolved)
  const typical = [behind[0]!]
  const surfaceLooks = (surface: PaletteToken, under: RGBA[]): RGBA[] => looks(spec, surface, resolved, under)
  const fails = (color: RGBA, surface: PaletteToken, min: number): boolean =>
    surfaceLooks(surface, behind).some((bg) => contrastRatio(color, bg) < min)
  const textured = spec.texture !== 'none'
  for (const { fg, on: all, min } of PALETTE_CONTRAST) {
    // The surfaces the theme set; a left-out one keeps its Dark default, which a light theme would
    // otherwise pull its text back towards. With none set, the theme's own colour against them all.
    const set = all.filter((s) => spec.palette[s] !== undefined)
    const on = set.length > 0 ? set : all
    const touched = textured || spec.effects.length > 0 || spec.palette[fg] !== undefined || set.length > 0
    if (!touched) continue
    let color = resolved(fg)
    let changed = false
    // Two passes: a nudge for one surface can undo another when surfaces differ a lot.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const surface of on) {
        for (const bg of surfaceLooks(surface, typical)) {
          if (contrastRatio(color, bg) < min) { color = nudgeForContrast(color, bg, min); changed = true }
        }
      }
    }
    // Then over everything that can show through, keeping a nudge only when it leaves fewer
    // failures, so a colour fitted to the usual backdrop gets the headroom glass needs without
    // see-sawing between a dark backdrop and a light one.
    const failures = (c: RGBA): number =>
      on.reduce((n, surface) => n + surfaceLooks(surface, behind).filter((bg) => contrastRatio(c, bg) < min).length, 0)
    for (const surface of on) {
      for (const bg of surfaceLooks(surface, behind)) {
        if (contrastRatio(color, bg) >= min) continue
        const moved = nudgeForContrast(color, bg, min)
        if (failures(moved) < failures(color)) { color = moved; changed = true }
      }
    }
    if (changed) { spec.palette[fg] = toHex8(color); report.nudged += 1 }
    for (const surface of on) {
      if (!fails(color, surface, min)) continue
      // Thicken the surface itself only when its own colour contrasts with the text; otherwise
      // thicken what it sits on.
      const ownColour = resolved(surface)
      const order: PaletteToken[] = contrastRatio(color, { ...ownColour, a: 1 }) >= min ? [surface] : []
      order.push(...(UNDERLAYS[surface] ?? []))
      const layers = order.filter((l) => spec.palette[l] !== undefined && resolved(l).a < 1)
      if (layers.length > 0) report.nudged += 1
      while (fails(color, surface, min) && layers.some((l) => resolved(l).a < 1)) {
        for (const l of layers) {
          const c = resolved(l)
          spec.palette[l] = toHex8({ ...c, a: Math.min(1, c.a + 0.05) })
        }
      }
      if (fails(color, surface, min)) {
        for (const bg of surfaceLooks(surface, behind)) {
          if (contrastRatio(color, bg) < min) color = nudgeForContrast(color, bg, min)
        }
        spec.palette[fg] = toHex8(color)
        report.nudged += 1
      }
    }
  }
}
