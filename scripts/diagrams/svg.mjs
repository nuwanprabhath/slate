// The SVG builder behind the README's architecture pictures: panels, boxes, stores and arrows in one
// style that follows the reader's light or dark theme.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Labels that look wider than the box they sit in. Rough, but it catches the ones that overflow. */
export const overflows = []
// Measured against the rendered font: the average glyph is about this fraction of the size.
const width = (s, size, bold) => s.length * size * (bold ? 0.56 : 0.52)
const fits = (s, size, bold, box, where) => {
  const w = width(s, size, bold)
  if (w > box - 16) overflows.push(`${where}: "${s}" is about ${Math.round(w)}px in a ${box}px box`)
}

const STYLE = `
  .bg { fill: #ffffff; }
  .t { fill: #1f2328; font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .s { fill: #59636e; font: 400 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .g { fill: #59636e; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; letter-spacing: .02em; }
  .l { fill: #59636e; font: 400 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .box { fill: #ffffff; stroke: #d0d7de; stroke-width: 1; }
  .ui { fill: #ddf4ff; stroke: #54aeff; }
  .main { fill: #fff8c5; stroke: #d4a72c; }
  .crypto { fill: #dafbe1; stroke: #4ac26b; }
  .secret { fill: #fbefff; stroke: #c297ff; }
  .out { fill: #f6f8fa; stroke: #d0d7de; }
  .grp { stroke-width: 1; }
  .sub { fill: #ffffff; fill-opacity: .55; stroke: #d0d7de; stroke-dasharray: 4 3; }
  .a { stroke: #6e7781; stroke-width: 1.5; fill: none; }
  .d { stroke-dasharray: 5 4; }
  .ah { fill: #6e7781; }
  .stop { stroke: #cf222e; stroke-width: 1.5; fill: none; }
  .stopt { fill: #cf222e; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .bad { fill: #ffebe9; stroke: #cf222e; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #0d1117; }
    .t { fill: #e6edf3; }
    .s, .g, .l { fill: #9198a1; }
    .box { fill: #161b22; stroke: #3d444d; }
    .ui { fill: #0c2d6b; fill-opacity: .55; stroke: #1f6feb; }
    .main { fill: #3b2e00; fill-opacity: .7; stroke: #9e6a03; }
    .crypto { fill: #033a16; fill-opacity: .7; stroke: #238636; }
    .secret { fill: #2b1c42; fill-opacity: .8; stroke: #a371f7; }
    .out { fill: #161b22; stroke: #3d444d; }
    .sub { fill: #0d1117; fill-opacity: .45; stroke: #3d444d; }
    .a { stroke: #8b949e; }
    .ah { fill: #8b949e; }
    .stop { stroke: #f85149; }
    .stopt { fill: #f85149; }
    .bad { fill: #3c1618; fill-opacity: .8; stroke: #f85149; }
  }`

export class Svg {
  constructor(w, h, title) {
    this.w = w
    this.h = h
    this.title = title
    this.parts = []
  }

  /** A titled panel behind a set of boxes. */
  group(x, y, w, h, label, cls) {
    this.parts.push(`<rect class="grp ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>`)
    if (label) this.parts.push(`<text class="g" x="${x + 14}" y="${y + 20}">${esc(label)}</text>`)
  }

  box(x, y, w, h, title, subs = [], cls = 'box') {
    this.parts.push(`<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>`)
    fits(title, 14, true, w, this.title)
    for (const s of subs) fits(s, 12, false, w, this.title)
    this.#lines(x + w / 2, y, h, title, subs)
  }

  /** A cylinder, for something stored on a disk. */
  store(x, y, w, h, title, subs = []) {
    const ry = 7
    this.parts.push(`<path class="box" d="M${x} ${y + ry} A${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} V${y + h - ry} A${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z"/>`)
    this.parts.push(`<path class="box" style="fill:none" d="M${x} ${y + ry} A${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}"/>`)
    this.#lines(x + w / 2, y + 5, h - 5, title, subs)
  }

  #lines(cx, y, h, title, subs) {
    const n = 1 + subs.length
    const total = 18 + (n - 1) * 16
    let ty = y + (h - total) / 2 + 14
    this.parts.push(`<text class="t" x="${cx}" y="${ty}" text-anchor="middle">${esc(title)}</text>`)
    for (const s of subs) {
      ty += 17
      this.parts.push(`<text class="s" x="${cx}" y="${ty}" text-anchor="middle">${esc(s)}</text>`)
    }
  }

  text(x, y, s, anchor = 'start', cls = 'l') {
    this.parts.push(`<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(s)}</text>`)
  }

  /** pts: [[x,y],...]; an arrowhead at the end, and at the start too when `both`. */
  arrow(pts, { dashed = false, both = false, head = true, cls = 'a' } = {}) {
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
    this.parts.push(`<path class="${cls}${dashed ? ' d' : ''}" d="${d}"/>`)
    if (head) this.#head(pts.at(-2), pts.at(-1), cls === 'stop' ? 'stop' : 'ah')
    if (both) this.#head(pts[1], pts[0], cls === 'stop' ? 'stop' : 'ah')
  }

  #head([x1, y1], [x2, y2], cls) {
    const a = Math.atan2(y2 - y1, x2 - x1)
    const L = 9
    const W = 4.5
    const bx = x2 - L * Math.cos(a)
    const by = y2 - L * Math.sin(a)
    const p = [
      [x2, y2],
      [bx + W * Math.sin(a), by - W * Math.cos(a)],
      [bx - W * Math.sin(a), by + W * Math.cos(a)],
    ]
    this.parts.push(`<path class="${cls === 'stop' ? 'ah' : cls}" d="M${p.map((q) => q.map((v) => v.toFixed(1)).join(' ')).join(' L')} Z"/>`)
  }

  /** A short bar across a line: this way is refused. */
  barred(x, y) {
    this.parts.push(`<path class="stop" d="M${x - 7} ${y - 7} L${x + 7} ${y + 7}"/>`)
    this.parts.push(`<path class="stop" d="M${x + 7} ${y - 7} L${x - 7} ${y + 7}"/>`)
  }

  raw(s) {
    this.parts.push(s)
  }

  toString() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.w} ${this.h}" width="${this.w}" height="${this.h}" role="img" aria-label="${esc(this.title)}">
<title>${esc(this.title)}</title>
<style>${STYLE}
</style>
<rect class="bg" x="0" y="0" width="${this.w}" height="${this.h}" rx="12"/>
${this.parts.join('\n')}
</svg>
`
  }
}
