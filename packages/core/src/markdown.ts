import type { PMJSON } from './plaintext'

const clean = (s: string) => s.replace(/ /g, ' ').replace(/[​-‍⁠﻿]/g, '').replace(/\r\n?/g, '\n')

function markText(node: PMJSON): string {
  let text = clean(node.text ?? '')
  const marks = node.marks ?? []
  const has = (type: string) => marks.some((m) => m.type === type)
  if (has('code')) text = `\`${text}\``
  if (has('bold')) text = `**${text}**`
  if (has('italic')) text = `_${text}_`
  if (has('strike')) text = `~~${text}~~`
  const link = marks.find((m) => m.type === 'link')
  if (link && typeof link.attrs?.href === 'string') text = `[${text}](${link.attrs.href})`
  return text
}

function inline(nodes: PMJSON[] = []): string {
  return nodes.map((n) => (n.type === 'text' ? markText(n) : n.type === 'hardBreak' ? '  \n' : inline(n.content))).join('')
}

function listLines(list: PMJSON, indent: string, marker: (i: number) => string): string[] {
  const out: string[] = []
  ;(list.content ?? []).forEach((item, i) => {
    const m = marker(i)
    const pad = indent + ' '.repeat(m.length)
    const [first, ...rest] = item.content ?? []
    out.push(indent + m + (first && first.type !== 'bulletList' && first.type !== 'orderedList' ? inline(first.content) : ''))
    for (const child of rest) out.push(...blockLines(child, pad))
  })
  return out
}

function blockLines(node: PMJSON, indent: string): string[] {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content).split('\n').map((l) => indent + l)
    case 'heading':
      return [indent + '#'.repeat(Number(node.attrs?.level ?? 1)) + ' ' + inline(node.content)]
    case 'bulletList':
      return listLines(node, indent, () => '- ')
    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1
      return listLines(node, indent, (i) => `${start + i}. `)
    }
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' && node.attrs.language !== 'plaintext' ? node.attrs.language : ''
      const code = (node.content ?? []).map((n) => (n.text ?? '').replace(/\r\n?/g, '\n')).join('')
      return [indent + '```' + lang, ...code.split('\n').map((l) => indent + l), indent + '```']
    }
    case 'blockquote':
      return (node.content ?? []).flatMap((c) => blockLines(c, '')).map((l) => `${indent}> ${l}`)
    case 'horizontalRule':
      return [indent + '---']
    case 'image':
      return [`${indent}![](${String(node.attrs?.src ?? '')})`]
    case 'table': {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => inline(c.content)).join(' ').replace(/\|/g, '\\|')))
      if (rows.length === 0) return []
      const line = (cells: string[]) => `${indent}| ${cells.join(' | ')} |`
      return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)]
    }
    default:
      return (node.content ?? []).flatMap((c) => blockLines(c, indent))
  }
}

/** Markdown for agents: GFM-flavoured, blocks separated by a blank line, real list numbers. */
export function toMarkdown(nodes: PMJSON[]): string {
  const blocks = nodes.flatMap((n) => (n.type === 'doc' ? n.content ?? [] : [n]))
  return blocks.map((b) => blockLines(b, '').join('\n')).filter((b) => b !== '').join('\n\n')
}

const text = (s: string): PMJSON[] => (s === '' ? [] : [{ type: 'text', text: s }])
const item = (s: string): PMJSON => ({ type: 'listItem', content: [{ type: 'paragraph', content: text(s) }] })

/** Markdown from an agent into blocks (no inline marks: agents' text is stored as typed). */
export function markdownToBlocks(md: string): PMJSON[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: PMJSON[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      const code: string[] = []
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i])
      blocks.push({ type: 'codeBlock', attrs: { language: fence[1] || 'plaintext' }, content: text(code.join('\n')) })
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', attrs: { level: heading[1].length }, content: text(heading[2]) })
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const items: PMJSON[] = []
      for (; i < lines.length && /^[-*]\s+/.test(lines[i]); i++) items.push(item(lines[i].replace(/^[-*]\s+/, '')))
      i--
      blocks.push({ type: 'bulletList', content: items })
      continue
    }
    const numbered = /^(\d+)\.\s+/.exec(line)
    if (numbered) {
      const items: PMJSON[] = []
      for (; i < lines.length && /^\d+\.\s+/.test(lines[i]); i++) items.push(item(lines[i].replace(/^\d+\.\s+/, '')))
      i--
      blocks.push({ type: 'orderedList', attrs: { start: Number(numbered[1]) }, content: items })
      continue
    }
    if (line.trim() !== '') blocks.push({ type: 'paragraph', content: text(line) })
  }
  return blocks
}
