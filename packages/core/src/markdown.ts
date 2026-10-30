import type { PMJSON } from './plaintext'

const clean = (s: string) => s.replace(/\u00A0/g, ' ').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\r\n?/g, '\n')

const isInline = (n: PMJSON) => n.type === 'text' || n.type === 'hardBreak'
const isList = (n: PMJSON) => n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList'

/** A code span fenced with one more backtick than the longest run inside it. */
function codeSpan(s: string): string {
  const fence = '`'.repeat(Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length)) + 1)
  return s.includes('`') ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`
}

/** One text node with its marks. Marks Markdown has no syntax for (underline, colour, highlight, …) leave the text bare. */
function markText(node: PMJSON): string {
  const raw = clean(node.text ?? '')
  const marks = node.marks ?? []
  const has = (type: string) => marks.some((m) => m.type === type)
  // `** a**` is not bold in Markdown, so edge spaces go outside the delimiters (code keeps them: they are code).
  const [, lead = '', core = '', trail = ''] = has('code') ? ['', '', raw, ''] : (/^(\s*)([\s\S]*?)(\s*)$/.exec(raw) ?? [])
  if (core === '') return raw
  let text = has('code') ? codeSpan(core) : core
  if (has('bold')) text = `**${text}**`
  if (has('italic')) text = `_${text}_`
  if (has('strike')) text = `~~${text}~~`
  const link = marks.find((m) => m.type === 'link')
  if (link && typeof link.attrs?.href === 'string') text = `[${text}](${link.attrs.href})`
  return lead + text + trail
}

function inline(nodes: PMJSON[] = []): string {
  return nodes.map((n) => (n.type === 'text' ? markText(n) : n.type === 'hardBreak' ? '  \n' : inline(n.content))).join('')
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ')
const indented = (pad: string) => (line: string) => (line === '' ? '' : pad + line)

/** An item's first paragraph goes on the marker's line; a later paragraph is set apart, a nested list is not. */
function listLines(list: PMJSON, marker: (i: number, item: PMJSON) => string, padWidth?: number): string[] {
  const out: string[] = []
  ;(list.content ?? []).forEach((item, i) => {
    const m = marker(i, item)
    const pad = indented(' '.repeat(padWidth ?? m.length))
    const children = item.content ?? []
    const first = children[0]
    const leads = first !== undefined && (first.type === 'paragraph' || first.type === 'heading')
    const head = leads ? blockLines(first) : ['']
    out.push(leads ? m + (head[0] ?? '') : m.trimEnd(), ...head.slice(1).map(pad))
    let started = leads
    for (const child of leads ? children.slice(1) : children) {
      const lines = blockLines(child)
      if (lines.length === 0) continue
      if (started && !isList(child)) out.push('')
      out.push(...lines.map(pad))
      started = true
    }
  })
  return out
}

/** A node as unindented lines; the caller indents them under a list item or quote. */
function blockLines(node: PMJSON): string[] {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content).split('\n')
    case 'heading':
      return ['#'.repeat(Number(node.attrs?.level ?? 1)) + ' ' + oneLine(inline(node.content))]
    case 'bulletList':
      return listLines(node, () => '- ')
    case 'taskList':
      return listLines(node, (_i, item) => (item.attrs?.checked === true ? '- [x] ' : '- [ ] '), 2)
    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1
      return listLines(node, (i) => `${start + i}. `)
    }
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' && node.attrs.language !== 'plaintext' ? node.attrs.language : ''
      const code = (node.content ?? []).map((n) => (n.text ?? '').replace(/\r\n?/g, '\n')).join('')
      const fence = '`'.repeat(Math.max(2, ...(code.match(/^`+/gm) ?? []).map((r) => r.length)) + 1)
      return [fence + lang, ...code.split('\n'), fence]
    }
    case 'blockquote':
      return blocks(node.content ?? []).map((l) => (l === '' ? '>' : `> ${l}`))
    case 'horizontalRule':
      return ['---']
    case 'image':
      return [`![${oneLine(String(node.attrs?.alt ?? ''))}](${String(node.attrs?.src ?? '')})`]
    case 'table': {
      const cellText = (cell: PMJSON) => oneLine((cell.content ?? []).map((c) => inline(c.content)).join(' ')).trim().replace(/\|/g, '\\|')
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map(cellText))
      if (rows.length === 0) return []
      const line = (cells: string[]) => `| ${cells.join(' | ')} |`
      return [line(rows[0]!), line(rows[0]!.map(() => '---')), ...rows.slice(1).map(line)]
    }
    default:
      // A node this serializer does not know (one a newer Slate added) keeps its text.
      return blocks(node.content ?? [])
  }
}

/** Blocks separated by a blank line; inline nodes outside a paragraph count as one. */
function blocks(nodes: PMJSON[]): string[] {
  const groups: PMJSON[] = []
  let loose: PMJSON[] | null = null
  for (const n of nodes) {
    if (!isInline(n)) {
      groups.push(n)
      loose = null
    } else if (loose) loose.push(n)
    else groups.push({ type: 'paragraph', content: (loose = [n]) })
  }
  const out: string[] = []
  for (const g of groups) {
    const lines = blockLines(g)
    if (lines.every((l) => l.trim() === '')) continue
    if (out.length > 0) out.push('')
    out.push(...lines)
  }
  return out
}

/** Markdown (GFM) for agents and Copy as Markdown: blocks separated by a blank line, real list numbers. */
export function toMarkdown(nodes: PMJSON[]): string {
  return blocks(nodes.flatMap((n) => (n.type === 'doc' ? n.content ?? [] : [n]))).join('\n')
}

const text = (s: string): PMJSON[] => (s === '' ? [] : [{ type: 'text', text: s }])
const item = (s: string): PMJSON => ({ type: 'listItem', content: [{ type: 'paragraph', content: text(s) }] })

/** Markdown from an agent into blocks (no inline marks: agents' text is stored as typed). */
export function markdownToBlocks(md: string): PMJSON[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: PMJSON[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      const code: string[] = []
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) code.push(lines[i]!)
      blocks.push({ type: 'codeBlock', attrs: { language: fence[1] || 'plaintext' }, content: text(code.join('\n')) })
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: text(heading[2]!) })
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const items: PMJSON[] = []
      for (; i < lines.length && /^[-*]\s+/.test(lines[i]!); i++) items.push(item(lines[i]!.replace(/^[-*]\s+/, '')))
      i--
      blocks.push({ type: 'bulletList', content: items })
      continue
    }
    const numbered = /^(\d+)\.\s+/.exec(line)
    if (numbered) {
      const items: PMJSON[] = []
      for (; i < lines.length && /^\d+\.\s+/.test(lines[i]!); i++) items.push(item(lines[i]!.replace(/^\d+\.\s+/, '')))
      i--
      blocks.push({ type: 'orderedList', attrs: { start: Number(numbered[1]) }, content: items })
      continue
    }
    if (line.trim() !== '') blocks.push({ type: 'paragraph', content: text(line) })
  }
  return blocks
}
