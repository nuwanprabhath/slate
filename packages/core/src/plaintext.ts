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

function listLines(list: PMJSON, indent: string, marker: (i: number) => string): string[] {
  const out: string[] = []
  ;(list.content ?? []).forEach((item, i) => {
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

function blockLines(node: PMJSON, indent: string): string[] {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return prefixLines(inlineText(node.content), indent)
    case 'codeBlock':
      return prefixLines((node.content ?? []).map((n) => (n.text ?? '').replace(/\r\n?/g, '\n')).join(''), indent)
    case 'bulletList':
      return listLines(node, indent, () => '- ')
    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1
      return listLines(node, indent, (i) => `${start + i}. `)
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
