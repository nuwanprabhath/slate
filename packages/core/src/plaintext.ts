/** ProseMirror JSON as produced by `Node.toJSON()` / `Fragment.toJSON()`. */
export interface PMJSON {
  type: string
  attrs?: Record<string, unknown>
  content?: PMJSON[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

const NBSP = /\u00A0/g
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g
const INDENT = '  '

function cleanText(s: string): string {
  return s.replace(NBSP, ' ').replace(ZERO_WIDTH, '').replace(/\r\n?/g, '\n')
}

function inlineText(nodes: PMJSON[] = []): string {
  return nodes
    .map((n) => (n.type === 'text' ? cleanText(n.text ?? '') : n.type === 'hardBreak' ? '\n' : inlineText(n.content)))
    .join('')
}

function prefixLines(text: string, indent: string): string[] {
  return text.split('\n').map((line) => indent + line)
}

/** A to-do item's box after its list marker; a plain item has no `checked` attribute. */
function todoBox(item: PMJSON): string {
  const checked = item.attrs?.checked
  return checked === true ? '[x] ' : checked === false ? '[ ] ' : ''
}

function listLines(list: PMJSON, indent: string, listMarker: (i: number) => string): string[] {
  const out: string[] = []
  ;(list.content ?? []).forEach((item, i) => {
    const marker = (n: number) => listMarker(n) + todoBox(item)
    const children = item.content ?? []
    const [first, ...rest] = children
    if (first && (first.type === 'paragraph' || first.type === 'heading')) {
      const [line0, ...more] = inlineText(first.content).split('\n')
      out.push(indent + marker(i) + line0)
      for (const line of more) out.push(indent + INDENT + line)
      out.push(...blocksToLines(rest, indent + INDENT))
    } else {
      out.push(indent + marker(i).trimEnd())
      out.push(...blocksToLines(children, indent + INDENT))
    }
  })
  return out
}

/** Spreadsheet-style letters, as CSS lower-alpha counts: 1 → a, 26 → z, 27 → aa. */
function alpha(n: number): string {
  let s = ''
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s
  return s || String(n)
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n)
  let s = ''
  let k = n
  for (const [v, r] of ROMAN) for (; k >= v; k -= v) s += r
  return s
}

/** The number a CSS list-style-type would draw, so the copied text matches the screen. */
function listLabel(style: string): (n: number) => string {
  switch (style) {
    case 'lower-alpha':
      return alpha
    case 'upper-alpha':
      return (n) => alpha(n).toUpperCase()
    case 'lower-roman':
      return roman
    case 'upper-roman':
      return (n) => roman(n).toUpperCase()
    default:
      return String
  }
}

/** A paragraph's or heading's indent level (WP-C2), as list nesting's two spaces per level. */
function blockIndent(node: PMJSON): string {
  const level = node.attrs?.indent
  return typeof level === 'number' && level > 0 ? INDENT.repeat(Math.min(level, 8)) : ''
}

function blockLines(node: PMJSON, indent: string): string[] {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return prefixLines(inlineText(node.content), indent + blockIndent(node))
    case 'codeBlock':
      return prefixLines((node.content ?? []).map((n) => (n.text ?? '').replace(/\r\n?/g, '\n')).join(''), indent)
    case 'bulletList':
      return listLines(node, indent, () => '- ')
    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1
      const label = listLabel(typeof node.attrs?.listStyle === 'string' ? node.attrs.listStyle : 'decimal')
      return listLines(node, indent, (i) => `${label(start + i)}. `)
    }
    case 'blockquote':
      return blocksToLines(node.content ?? [], indent + '> ')
    case 'horizontalRule':
      return [indent + '---']
    case 'table':
      return (node.content ?? []).map(
        (row) => indent + (row.content ?? []).map((cell) => blocksToLines(cell.content ?? [], '').join(' ')).join('\t'),
      )
    case 'image':
      return []
    default:
      return blocksToLines(node.content ?? [], indent)
  }
}

function blocksToLines(nodes: PMJSON[], indent: string): string[] {
  const out: string[] = []
  let inline: PMJSON[] = []
  const flush = () => {
    if (inline.length > 0) out.push(...prefixLines(inlineText(inline), indent))
    inline = []
  }
  for (const n of nodes) {
    if (n.type === 'text' || n.type === 'hardBreak') inline.push(n)
    else {
      flush()
      out.push(...blockLines(n, indent))
    }
  }
  flush()
  return out
}

/** Plain text for the clipboard: real list numbers, verbatim code, LF only, no invisible characters. */
export function toPlainText(nodes: PMJSON[]): string {
  return blocksToLines(nodes, '').join('\n').replace(/\n+$/, '')
}
