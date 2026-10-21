import { parseHTML } from 'linkedom'

const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function styleOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const at = part.indexOf(':')
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim()
  }
  return out
}

/** Replaces an element by its children. */
function unwrap(el: Element): void {
  while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el)
  el.remove()
}

/** one2html draws checkboxes as inline SVG; the mapper reads `data-tag` instead. */
function simplifyTags(root: Element): void {
  for (const li of Array.from(root.querySelectorAll('li'))) {
    const box = li.querySelector('[role="checkbox"]')
    if (box) li.setAttribute('data-tag', box.getAttribute('aria-checked') === 'true' ? 'to-do:completed' : 'to-do')
  }
  for (const icon of Array.from(root.querySelectorAll('.note-tag-icon'))) icon.remove()
}

// OneNote stores some links as Word-style field codes; one2html leaves them in the text as
// U+FDDF `HYPERLINK "url"` followed by the display text (to the end of the run).
const FIELD_LINK = /﷟HYPERLINK\s+"([^"]*)"/

function linkFieldCodes(root: Element): void {
  const doc = root.ownerDocument
  const walker: Text[] = []
  const collect = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) walker.push(child as Text)
      else collect(child)
    }
  }
  collect(root)
  for (const text of walker) {
    const value = text.data
    const m = FIELD_LINK.exec(value)
    if (!m) continue
    const before = value.slice(0, m.index)
    // The display text runs to the next field code or the end of this text node.
    const rest = value.slice(m.index + m[0].length)
    const next = rest.search(/﷟/)
    const display = (next < 0 ? rest : rest.slice(0, next)) || m[1]!
    const after = next < 0 ? '' : rest.slice(next)
    const a = doc.createElement('a')
    a.setAttribute('href', m[1]!)
    a.textContent = display
    const parts: Node[] = []
    if (before) parts.push(doc.createTextNode(before))
    parts.push(a)
    if (after) parts.push(doc.createTextNode(after))
    text.replaceWith(...parts)
    // A second field code in the same run is now in `after`, a fresh text node: scan again.
    if (after) {
      linkFieldCodes(root)
      return
    }
  }
}

/** Keeps the content, drops what only styled one2html's own page. */
function clean(root: Element): void {
  linkFieldCodes(root)
  simplifyTags(root)
  for (const el of Array.from(root.querySelectorAll('script, style, svg'))) el.remove()
  for (const el of Array.from(root.querySelectorAll('div.outline-element'))) unwrap(el)
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    el.removeAttribute('class')
    // `"Calibri", sans-serif` would reach the mapper as one font name with a stray quote.
    const style = el.getAttribute('style')
    if (style?.includes('font-family')) el.setAttribute('style', style.replace(/font-family:\s*("[^"]*"|'[^']*'|[^;,]*)[^;]*/, (_m, first: string) => `font-family: ${first.replace(/["']/g, '')}`))
    // List indent comes from list nesting; one2html's offsets are for its own bullet drawing.
    if (tag === 'ul' || tag === 'ol' || tag === 'li') el.removeAttribute('style')
  }
}

/** The outline's width: its own max-width, or the first descendant that has one. */
function widthOf(outline: Element): number | undefined {
  for (const el of [outline, ...Array.from(outline.querySelectorAll('[style*="max-width"]'))]) {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(styleOf(el)['max-width'] ?? '')
    if (m) return Number(m[1])
  }
  return undefined
}

/**
 * Turns a one2html page into the Graph page HTML that `mapOneNotePage` reads: one absolutely
 * positioned div per outline. The page title lives in `<title>`, so the converter's title block
 * (title, date, time) is dropped, as Graph's body does not carry it either.
 */
export function normalizeOne2HtmlPage(html: string, options: { rewriteSrc?: (src: string) => string } = {}): string {
  const { document } = parseHTML(html)
  // The image src is relative to the converted page; the caller knows where that is.
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    if (!src) continue
    if (options.rewriteSrc) img.setAttribute('src', options.rewriteSrc(src))
    // Marks the image as the importer's own resource rather than an external link.
    img.setAttribute('data-src-type', 'image')
  }
  const title = (document.querySelector('title')?.textContent ?? '').trim()
  const boxes: string[] = []
  let ink = false
  for (const child of Array.from(document.body.children)) {
    const tag = child.tagName.toLowerCase()
    const style = styleOf(child)
    if (tag === 'svg' && style.position === 'absolute') {
      ink = true
      continue
    }
    if (tag !== 'div' || style.position !== 'absolute' || child.classList.contains('title')) continue
    const width = widthOf(child)
    clean(child)
    if (!/\S/.test(child.textContent ?? '') && !child.querySelector('img, table')) continue
    const left = parseFloat(style.left ?? '0') || 0
    const top = parseFloat(style.top ?? '0') || 0
    boxes.push(`<div style="position:absolute;left:${left}px;top:${top}px${width ? `;width:${width}px` : ''}">${child.innerHTML.trim()}</div>`)
  }
  const inkMarker = ink ? '<div data-ink="true"></div>' : ''
  return `<html><head><title>${escapeText(title)}</title></head><body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">${boxes.join('')}${inkMarker}</body></html>`
}

/** The section's pages in order, from the index's `<nav>`. `file` is relative to the index. */
export function parseOne2HtmlSection(indexHtml: string): Array<{ title: string; file: string; level: number }> {
  const { document } = parseHTML(indexHtml)
  return Array.from(document.querySelectorAll('nav a')).map((a) => {
    const href = a.getAttribute('href') ?? ''
    let file = href
    try {
      file = decodeURIComponent(href)
    } catch {
      // keep the raw href
    }
    const level = Number(/\bl(\d)\b/.exec(a.getAttribute('class') ?? '')?.[1] ?? 1) - 1
    const title = a.getAttribute('title') ?? a.textContent ?? ''
    return { title: title.trim(), file, level: Math.max(0, Math.min(2, level)) }
  })
}
