/**
 * Display-time colour adaptation. Imported pages carry literal colours (mostly black) that
 * OneNote draws adaptively; we do the same at render time and never rewrite the stored marks.
 */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
  navy: '#000080',
  purple: '#800080',
  teal: '#008080',
  orange: '#ffa500',
}

function channel(s: string): number {
  return s.endsWith('%') ? Math.round((parseFloat(s) / 100) * 255) : Math.round(parseFloat(s))
}

function alpha(s: string | undefined): number {
  if (s === undefined) return 1
  return s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)
}

export function parseColor(css: string): Rgba | null {
  const s = css.trim().toLowerCase()
  const named = NAMED[s]
  if (named) return parseColor(named)
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s)
  if (!fn) return null
  const parts = fn[1]!.includes(',') ? fn[1]!.split(',') : fn[1]!.replace('/', ' ').split(/\s+/)
  const p = parts.map((x) => x.trim()).filter(Boolean)
  if (p.length !== 3 && p.length !== 4) return null
  const [r, g, b] = p.slice(0, 3).map(channel)
  const a = alpha(p[3])
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null
  return { r: r!, g: g!, b: b!, a }
}

export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function ratio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function contrastRatio(a: string, b: string): number {
  const ca = parseColor(a)
  const cb = parseColor(b)
  return ca && cb ? ratio(ca, cb) : 1
}

function toHsl({ r, g, b }: Rgba): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  return [h / 6, s, l]
}

function fromHsl(h: number, s: number, l: number, a: number): Rgba {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v, a }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return { r: Math.round(hue(h + 1 / 3) * 255), g: Math.round(hue(h) * 255), b: Math.round(hue(h - 1 / 3) * 255), a }
}

function format({ r, g, b, a }: Rgba): string {
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Flips HSL lightness (what OneNote's dark mode does), then nudges towards the far end until it passes. */
function adapt(c: Rgba, against: Rgba, minRatio: number): Rgba {
  if (ratio(c, against) >= minRatio) return c
  const [h, s, l] = toHsl(c)
  const target = relativeLuminance(against) < 0.18 ? 1 : 0
  let nl = 1 - l
  let out = fromHsl(h, s, nl, c.a)
  for (let i = 0; i < 20 && ratio(out, against) < minRatio; i++) {
    nl += (target - nl) * 0.25
    out = fromHsl(h, s, i === 19 ? target : nl, c.a)
  }
  return out
}

const colorCache = new Map<string, string>()
const highlightCache = new Map<string, string>()

export function readableColor(css: string, background: string, minRatio = 3): string {
  const key = `${css}|${background}|${minRatio}`
  let out = colorCache.get(key)
  if (out === undefined) {
    const c = parseColor(css)
    const bg = parseColor(background)
    const adapted = c && bg ? adapt(c, bg, minRatio) : c
    out = !c || adapted === c ? css : format(adapted!)
    colorCache.set(key, out)
  }
  return out
}

/** Keeps the text drawn on a highlight at 4.5:1 or better by moving the highlight, not the text. */
export function readableHighlight(bg: string, textColor: string, minRatio = 4.5): string {
  const key = `${bg}|${textColor}|${minRatio}`
  let out = highlightCache.get(key)
  if (out === undefined) {
    const c = parseColor(bg)
    const text = parseColor(textColor)
    const adapted = c && text ? adapt(c, text, minRatio) : c
    out = !c || adapted === c ? bg : format(adapted!)
    highlightCache.set(key, out)
  }
  return out
}

export interface Theme {
  dark: boolean
  background: string
  text: string
}

// Mirrors --bg and --text in the desktop app.css.
const DARK_THEME: Theme = { dark: true, background: '#1e1e1e', text: '#e6e6e6' }
const LIGHT_THEME: Theme = { dark: false, background: '#ffffff', text: '#1f1f1f' }

function query(): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null
}

let theme: Theme = query()?.matches ? LIGHT_THEME : DARK_THEME
const listeners = new Set<() => void>()
query()?.addEventListener?.('change', (e) => {
  theme = e.matches ? LIGHT_THEME : DARK_THEME
  for (const l of listeners) l()
})

export function currentTheme(): Theme {
  return theme
}

export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
