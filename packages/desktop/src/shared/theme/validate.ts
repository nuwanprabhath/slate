import { parseColor, toHex8 } from './color'
import { isOneOf, own } from './guards'
import {
  PALETTE_TOKENS, MATERIALS, TEXTURE_KINDS, EFFECT_KINDS, FONTS, LIMITS, BASE_THEME, SURFACES, DEFAULT_GLASS,
  type ThemeSpec, type EffectSpec, type Material, type PaletteToken, type GlassSpec, type SurfaceSpec,
} from './spec'
import { ensureReadable, emptyReport, type ThemeReport } from './readability'

export type { ThemeReport } from './readability'

/**
 * The one way anything becomes a theme: the security boundary of the theme feature.
 *
 * Its input is untrusted by construction (a reply from Claude, a stored theme from an older or
 * newer Slate). It never throws, and it never returns a value it has not checked:
 *
 * - Only the names on the allowlists in spec.ts are read, as own properties; unknown keys,
 *   `__proto__` and `constructor` are never looked at.
 * - Colours go through `parseColor` and come out re-serialised as `#rrggbbaa`; anything that is
 *   not unmistakably a colour is dropped and the default shows instead.
 * - Numbers are clamped, enums must match, at most `LIMITS.maxEffects` effects survive.
 * - Surfaces that must stay solid are made opaque (`limitAlpha`), and finally text that would
 *   not be legible on what it sits on is nudged until it is (`ensureReadable`).
 */

function sanitizeName(v: unknown): string {
  if (typeof v !== 'string') return 'Untitled theme'
  // eslint-disable-next-line no-control-regex -- control characters are what the pattern removes
  const clean = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxNameChars)
  return clean === '' ? 'Untitled theme' : clean
}

function unit(v: unknown, report: ThemeReport): number {
  if (v === undefined) return 0.5
  if (typeof v !== 'number' || !Number.isFinite(v)) { report.clamped += 1; return 0.5 }
  if (v < 0 || v > 1) { report.clamped += 1; return Math.min(1, Math.max(0, v)) }
  return v
}

function colors(input: unknown, report: ThemeReport): Partial<Record<PaletteToken, string>> {
  const out: Partial<Record<PaletteToken, string>> = {}
  for (const name of PALETTE_TOKENS) {
    const v = own(input, name)
    if (v === undefined) continue
    const c = typeof v === 'string' ? parseColor(v) : null
    if (c === null) { report.droppedColors += 1; continue }
    out[name] = toHex8(c)
  }
  return out
}

/**
 * How see-through a surface may be. Solid keeps the reading surfaces opaque. Glass lets the page
 * and panels show the window and its effects, but keeps enough body for `ensureReadable` to work
 * with, and popovers (which float over text, not over the backdrop) almost opaque.
 */
const MIN_ALPHA: Record<Material, Partial<Record<PaletteToken, number>>> = {
  solid: { 'bg': 1, 'page': 1, 'panel': 1, 'toolbar-bg': 1, 'sidebar-bg': 1, 'popover': 1 },
  glass: { 'bg': 1, 'page': 0.35, 'panel': 0.5, 'panel-2': 0.3, 'toolbar-bg': 0.3, 'sidebar-bg': 0.3, 'popover': 0.92 },
}

function limitAlpha(spec: ThemeSpec, report: ThemeReport): void {
  for (const [token, min] of Object.entries(MIN_ALPHA[spec.material]) as Array<[PaletteToken, number]>) {
    const v = spec.palette[token]
    if (v === undefined) continue
    const c = parseColor(v)!
    if (c.a < min) { spec.palette[token] = toHex8({ ...c, a: min }); report.clamped += 1 }
  }
}

function effects(input: unknown, report: ThemeReport): EffectSpec[] {
  if (!Array.isArray(input)) return []
  const out: EffectSpec[] = []
  for (const e of input as unknown[]) {
    const kind = own(e, 'kind')
    if (!isOneOf(EFFECT_KINDS, kind) || out.length >= LIMITS.maxEffects) { report.unknown += 1; continue }
    const effect: EffectSpec = { kind, intensity: unit(own(e, 'intensity'), report), speed: unit(own(e, 'speed'), report), density: unit(own(e, 'density'), report) }
    const color = own(e, 'color')
    if (isOneOf(PALETTE_TOKENS, color)) effect.color = color
    else if (color !== undefined) report.unknown += 1
    out.push(effect)
  }
  return out
}

function ranged(v: unknown, { min, max }: { min: number; max: number }, fallback: number, report: ThemeReport): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) { report.clamped += 1; return fallback }
  if (v < min || v > max) { report.clamped += 1; return Math.min(max, Math.max(min, v)) }
  return v
}

function glass(input: unknown, report: ThemeReport): GlassSpec | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'object' || input === null) { report.unknown += 1; return undefined }
  return {
    saturation: ranged(own(input, 'saturation'), LIMITS.saturation, DEFAULT_GLASS.saturation, report),
    highlight: ranged(own(input, 'highlight'), { min: 0, max: 1 }, DEFAULT_GLASS.highlight, report),
    refraction: ranged(own(input, 'refraction'), { min: 0, max: 1 }, DEFAULT_GLASS.refraction, report),
  }
}

/** A surface keeps only an allowlisted texture and a gradient between two palette token names. */
function surfaces(input: unknown, report: ThemeReport): ThemeSpec['surfaces'] {
  if (input === undefined) return undefined
  if (typeof input !== 'object' || input === null) { report.unknown += 1; return undefined }
  const out: NonNullable<ThemeSpec['surfaces']> = {}
  for (const k of Object.keys(input)) if (!isOneOf(SURFACES, k)) report.unknown += 1
  for (const name of SURFACES) {
    const s = own(input, name)
    if (s === undefined) continue
    const kept: SurfaceSpec = {}
    const texture = own(s, 'texture')
    if (isOneOf(TEXTURE_KINDS, texture) && texture !== 'none') kept.texture = texture
    else if (texture !== undefined) report.unknown += 1
    const g = own(s, 'gradient')
    if (g !== undefined) {
      const from = own(g, 'from')
      const to = own(g, 'to')
      if (isOneOf(PALETTE_TOKENS, from) && isOneOf(PALETTE_TOKENS, to)) kept.gradient = { from, to, angle: ranged(own(g, 'angle'), LIMITS.angle, 180, report) }
      else report.unknown += 1
    }
    if (kept.texture !== undefined || kept.gradient !== undefined) out[name] = kept
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function choice<T extends string>(list: readonly T[], v: unknown, fallback: T, report: ThemeReport): T {
  if (isOneOf(list, v)) return v
  if (v !== undefined) report.unknown += 1
  return fallback
}

export function validateTheme(input: unknown): { spec: ThemeSpec; report: ThemeReport } {
  const report = emptyReport()
  let size = Infinity
  try { size = JSON.stringify(input)?.length ?? Infinity } catch { /* cyclic or exotic: refused */ }
  if (typeof input !== 'object' || input === null || Array.isArray(input) || size > LIMITS.maxInputChars) {
    return { spec: structuredClone(BASE_THEME), report }
  }
  const spec: ThemeSpec = {
    version: 1,
    name: sanitizeName(own(input, 'name')),
    palette: colors(own(input, 'palette'), report),
    material: choice(MATERIALS, own(input, 'material'), 'solid', report),
    texture: choice(TEXTURE_KINDS, own(input, 'texture'), 'none', report),
    effects: effects(own(input, 'effects'), report),
    font: choice(FONTS, own(input, 'font'), 'system', report),
  }
  const uiFont = own(input, 'uiFont')
  if (uiFont !== undefined) spec.uiFont = choice(FONTS, uiFont, 'system', report)
  const lens = glass(own(input, 'glass'), report)
  if (lens !== undefined && spec.material === 'glass') spec.glass = lens
  const painted = surfaces(own(input, 'surfaces'), report)
  if (painted !== undefined) spec.surfaces = painted
  limitAlpha(spec, report)
  ensureReadable(spec, report)
  return { spec, report }
}

export function describeReport(r: ThemeReport): string | null {
  const parts: string[] = []
  const n = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`
  if (r.nudged > 0) parts.push(`${n(r.nudged, 'colour', 'colours')} adjusted for readability`)
  if (r.droppedColors > 0) parts.push(`${n(r.droppedColors, 'invalid colour', 'invalid colours')} ignored`)
  if (r.unknown > 0) parts.push(`${n(r.unknown, 'unknown option', 'unknown options')} ignored`)
  if (r.clamped > 0) parts.push(`${n(r.clamped, 'value', 'values')} brought into range`)
  return parts.length === 0 ? null : parts.join(', ')
}
