import { parseHTML } from 'linkedom'
import type { PMJSON } from '@slate/core'
import type { MappedBox, MappedPage } from './types'

type Mark = NonNullable<PMJSON['marks']>[number]

interface State {
  lossy: string[]
  defaultFamily: string
  defaultSize: string
}

const ZERO_WIDTH = /[​-‍⁠﻿]/g
const NBSP = / /g
const MONOSPACE = /consolas|courier|menlo|monaco|monospace/i
const HEADING = /^h([1-6])$/
const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'table', 'div', 'pre', 'img', 'object', 'iframe'])
const DEFAULT_WIDTH = 480
const TOP_MARGIN = 40
const LOOSE_X = 48
// OneNote does not report block heights, so a box of loose content goes below the positioned ones
// with a fixed gap.
const LOOSE_GAP = 80
const MONO_MARKER = '__mono'

function parseStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of style.split(';')) {
    const at = part.indexOf(':')
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim()
  }
  return out
}

function px(value: string | undefined): number | null {
  const m = /^(-?\d+(?:\.\d+)?)(px|pt)?$/.exec(value ?? '')
  if (!m) return null
  const n = m[2] === 'pt' ? (Number(m[1]) * 4) / 3 : Number(m[1])
  return Math.round(n * 100) / 100
}

const normFont = (value: string | undefined): string => (value ?? '').replace(/["']/g, '').trim().toLowerCase()

function tagMarks(el: Element, tag: string): Mark[] {
  switch (tag) {
    case 'b':
    case 'strong':
      return [{ type: 'bold' }]
    case 'i':
    case 'em':
      return [{ type: 'italic' }]
    case 'u':
      return [{ type: 'underline' }]
    case 's':
    case 'del':
    case 'strike':
      return [{ type: 'strike' }]
    case 'a': {
      const href = el.getAttribute('href')
      return href ? [{ type: 'link', attrs: { href } }] : []
    }
    default:
      return []
  }
}

function styleMarks(style: Record<string, string>, st: State): Mark[] {
  const out: Mark[] = []
  const weight = style['font-weight']
  if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 700) out.push({ type: 'bold' })
  if (style['font-style']?.includes('italic')) out.push({ type: 'italic' })
  const decoration = style['text-decoration'] ?? ''
  if (decoration.includes('underline')) out.push({ type: 'underline' })
  if (decoration.includes('line-through')) out.push({ type: 'strike' })
  const textStyle: Record<string, unknown> = {}
  const family = style['font-family']
  if (family && normFont(family) !== st.defaultFamily) textStyle.fontFamily = family.replace(/^["']|["']$/g, '')
  const size = style['font-size']
  if (size && size.toLowerCase() !== st.defaultSize) textStyle.fontSize = size
  if (style.color) textStyle.color = style.color
  if (Object.keys(textStyle).length > 0) out.push({ type: 'textStyle', attrs: textStyle })
  if (style['background-color']) out.push({ type: 'highlight', attrs: { color: style['background-color'] } })
  return out
}

/** Adds marks to an inherited list: one mark per type, textStyle attrs merged, a nearer link wins. */
function addMarks(base: Mark[], extra: Mark[]): Mark[] {
  const out = base.map((m) => ({ ...m }))
  for (const m of extra) {
    const at = out.findIndex((o) => o.type === m.type)
    if (at < 0) out.push({ ...m })
    else if (m.type === 'textStyle') out[at] = { type: 'textStyle', attrs: { ...out[at]!.attrs, ...m.attrs } }
    else if (m.type === 'link' || m.type === 'highlight') out[at] = { ...m }
  }
  return out
}

function ownMarks(el: Element, tag: string, marks: Mark[], st: State): Mark[] {
  return addMarks(marks, [...tagMarks(el, tag), ...styleMarks(parseStyle(el.getAttribute('style') ?? ''), st)])
}

function inlineOf(node: Node, marks: Mark[], st: State): PMJSON[] {
  if (node.nodeType === 3) {
    // NBSP stays until cleanInline so that indentation survives the trimming there.
    const value = (node.textContent ?? '').replace(/[ \t\r\n]+/g, ' ').replace(ZERO_WIDTH, '')
    return value === '' ? [] : [{ type: 'text', text: value, ...(marks.length > 0 ? { marks } : {}) }]
  }
  if (node.nodeType !== 1) return []
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (tag === 'br') return [{ type: 'hardBreak' }]
  if (tag === 'script' || tag === 'style') return []
  const next = ownMarks(el, tag, marks, st)
  return Array.from(el.childNodes).flatMap((child) => inlineOf(child, next, st))
}

/** Trims block edges, turns NBSP into spaces and merges neighbouring runs with equal marks. */
function cleanInline(nodes: PMJSON[]): PMJSON[] {
  const out: PMJSON[] = []
  for (const n of nodes) {
    if (n.type !== 'text') {
      out.push(n)
      continue
    }
    const prev = out[out.length - 1]
    if (prev?.type === 'text' && JSON.stringify(prev.marks) === JSON.stringify(n.marks)) prev.text = (prev.text ?? '') + (n.text ?? '')
    else out.push({ ...n })
  }
  const first = out[0]
  if (first?.type === 'text') first.text = (first.text ?? '').replace(/^[ \t\r\n]+/, '')
  const last = out[out.length - 1]
  if (last?.type === 'text') last.text = (last.text ?? '').replace(/[ \t\r\n]+$/, '')
  const cleaned = out.filter((n) => n.type !== 'text' || n.text !== '').map((n) => (n.type === 'text' ? { ...n, text: (n.text ?? '').replace(NBSP, ' ') } : n))
  // OneNote spaces paragraphs with NBSP-only ones; those are empty paragraphs.
  return cleaned.every((n) => n.type === 'text' && /^\s*$/.test(n.text ?? '')) ? [] : cleaned
}

const paragraph = (content: PMJSON[]): PMJSON => (content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' })

function plainOf(content: PMJSON[] = []): string {
  return content.map((n) => (n.type === 'hardBreak' ? '\n' : (n.text ?? ''))).join('')
}

function mergeCodeParagraphs(blocks: PMJSON[]): PMJSON[] {
  const isMono = (b: PMJSON): boolean => b.type === 'paragraph' && b.attrs?.[MONO_MARKER] === true
  const out: PMJSON[] = []
  for (let i = 0; i < blocks.length; i++) {
    if (!isMono(blocks[i]!)) {
      out.push(blocks[i]!)
      continue
    }
    let end = i
    while (end < blocks.length && isMono(blocks[end]!)) end++
    const run = blocks.slice(i, end)
    if (run.length >= 2) {
      const code = run.map((p) => plainOf(p.content)).join('\n')
      out.push({ type: 'codeBlock', attrs: { language: 'plaintext' }, ...(code !== '' ? { content: [{ type: 'text', text: code }] } : {}) })
    } else out.push(paragraph(run[0]!.content ?? []))
    i = end - 1
  }
  return out.filter((b, i) => !(isEmptyParagraph(b) && i > 0 && isEmptyParagraph(out[i - 1]!)))
}

const isEmptyParagraph = (b: PMJSON): boolean => b.type === 'paragraph' && !b.content

function todoPrefix(el: Element): string {
  const tag = el.getAttribute('data-tag') ?? ''
  if (!tag.includes('to-do')) return ''
  return tag.includes('completed') ? '☑ ' : '☐ '
}

function isBlock(el: Element, tag: string): boolean {
  return BLOCK_TAGS.has(tag) || HEADING.test(tag) || el.hasAttribute('data-ink')
}

function blocksOfNodes(
  nodes: Node[],
  marks: Mark[],
  st: State,
  textBlock: (content: PMJSON[]) => PMJSON = paragraph,
  prefix = '',
): PMJSON[] {
  const out: PMJSON[] = []
  let buffer: PMJSON[] = prefix ? [{ type: 'text', text: prefix }] : []
  const flush = (): void => {
    const content = cleanInline(buffer)
    buffer = []
    if (content.length > 0) out.push(textBlock(content))
  }
  for (const node of nodes) {
    if (node.nodeType === 1 && isBlock(node as Element, (node as Element).tagName.toLowerCase())) {
      flush()
      out.push(...blockOf(node as Element, marks, st))
    } else buffer.push(...inlineOf(node, marks, st))
  }
  flush()
  return mergeCodeParagraphs(out)
}

function imageBlock(el: Element, st: State): PMJSON[] {
  const src = el.getAttribute('src')
  if (!src) return []
  const isGraphResource = el.hasAttribute('data-src-type') || /\/onenote\/resources\//.test(src) || src.startsWith('data:')
  if (!isGraphResource) st.lossy.push('External image')
  return [{ type: 'image', attrs: { src, alt: el.getAttribute('alt') ?? '', ...displaySize(el) } }]
}

/**
 * The size the image was shown at in OneNote: Graph puts it in width/height attributes, one2html
 * in max-width/max-height styles. Without it a screenshot shows at full resolution and overlaps
 * the boxes below it.
 */
function displaySize(el: Element): { width?: number; height?: number } {
  const style = parseStyle(el.getAttribute('style') ?? '')
  const pick = (attr: string, ...props: string[]): number | undefined => {
    const fromAttr = Number(el.getAttribute(attr))
    if (Number.isFinite(fromAttr) && fromAttr > 0) return Math.round(fromAttr)
    for (const prop of props) {
      const v = px(style[prop] ?? '')
      if (v !== null && v > 0) return Math.round(v)
    }
    return undefined
  }
  const width = pick('width', 'width', 'max-width')
  const height = pick('height', 'height', 'max-height')
  return { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }
}

/** Ink, attachments and embeds: OneNote content Slate cannot show, kept as far as it can be. */
function lossyBlock(el: Element, tag: string, st: State): PMJSON[] | null {
  if (el.hasAttribute('data-ink') || (tag === 'img' && /^ink/i.test(el.getAttribute('alt') ?? ''))) {
    if (tag === 'img' && el.getAttribute('src')) {
      st.lossy.push('Ink drawing (imported as image)')
      return imageBlock(el, st)
    }
    st.lossy.push('Ink drawing (not imported)')
    return []
  }
  if (tag === 'object') {
    const name = el.getAttribute('data-attachment')
    if (!name) return []
    st.lossy.push(`Attachment "${name}"`)
    return [paragraph([{ type: 'text', text: `[Attachment: ${name}]` }])]
  }
  if (tag === 'iframe') {
    const src = el.getAttribute('data-original-src') ?? el.getAttribute('src')
    if (!src) return []
    let host = src
    try {
      host = new URL(src).hostname
    } catch {
      // keep the raw value as the label
    }
    st.lossy.push(`Embedded content (${host})`)
    return [paragraph([{ type: 'text', text: src, marks: [{ type: 'link', attrs: { href: src } }] }])]
  }
  return null
}

function rowsOf(el: Element): Element[] {
  return Array.from(el.children).flatMap((child) => {
    const tag = child.tagName.toLowerCase()
    return tag === 'tr' ? [child] : tag === 'thead' || tag === 'tbody' || tag === 'tfoot' ? rowsOf(child) : []
  })
}

function tableBlock(el: Element, marks: Mark[], st: State): PMJSON {
  const rows = rowsOf(el).map((tr): PMJSON => {
    const rowMarks = ownMarks(tr, 'tr', marks, st)
    const cells = Array.from(tr.children)
      .filter((c) => ['td', 'th'].includes(c.tagName.toLowerCase()))
      .map((cell): PMJSON => {
        const tag = cell.tagName.toLowerCase()
        const content = blocksOfNodes(Array.from(cell.childNodes), ownMarks(cell, tag, rowMarks, st), st)
        return { type: tag === 'th' ? 'tableHeader' : 'tableCell', content: content.length > 0 ? content : [paragraph([])] }
      })
    return { type: 'tableRow', content: cells }
  })
  return { type: 'table', content: rows }
}

function listBlock(el: Element, tag: string, marks: Mark[], st: State): PMJSON {
  const items = Array.from(el.children)
    .filter((c) => c.tagName.toLowerCase() === 'li')
    .map((li): PMJSON => {
      const content = blocksOfNodes(Array.from(li.childNodes), ownMarks(li, 'li', marks, st), st, paragraph, todoPrefix(li))
      return { type: 'listItem', content: content.length > 0 ? content : [paragraph([])] }
    })
  return tag === 'ol'
    ? { type: 'orderedList', attrs: { start: Number(el.getAttribute('start')) || 1 }, content: items }
    : { type: 'bulletList', content: items }
}

function blockOf(el: Element, inherited: Mark[], st: State): PMJSON[] {
  const tag = el.tagName.toLowerCase()
  const special = lossyBlock(el, tag, st)
  if (special) return special
  if (tag === 'img') return imageBlock(el, st)
  const marks = ownMarks(el, tag, inherited, st)
  const kids = Array.from(el.childNodes)
  const heading = HEADING.exec(tag)
  if (heading) {
    const level = Math.min(3, Number(heading[1]))
    return blocksOfNodes(kids, marks, st, (content) => ({ type: 'heading', attrs: { level }, content }), todoPrefix(el))
  }
  switch (tag) {
    case 'p': {
      const before = st.lossy.length
      const blocks = blocksOfNodes(kids, marks, st, paragraph, todoPrefix(el))
      if (blocks.length === 0 && st.lossy.length === before) blocks.push(paragraph([]))
      if (MONOSPACE.test(parseStyle(el.getAttribute('style') ?? '')['font-family'] ?? '')) {
        for (const b of blocks) if (b.type === 'paragraph') b.attrs = { [MONO_MARKER]: true }
      }
      return blocks
    }
    case 'ul':
    case 'ol':
      return [listBlock(el, tag, marks, st)]
    case 'table':
      return [tableBlock(el, marks, st)]
    case 'pre': {
      const code = (el.textContent ?? '').replace(ZERO_WIDTH, '').replace(NBSP, ' ').replace(/\r\n?/g, '\n').replace(/\n$/, '')
      return [{ type: 'codeBlock', attrs: { language: 'plaintext' }, ...(code !== '' ? { content: [{ type: 'text', text: code }] } : {}) }]
    }
    default:
      return blocksOfNodes(kids, marks, st, paragraph, todoPrefix(el))
  }
}

export function mapOneNotePage(html: string): MappedPage {
  const { document } = parseHTML(html)
  const title = (document.querySelector('title')?.textContent ?? '').trim()
  const body = document.body ?? document.documentElement
  const bodyStyle = parseStyle(body.getAttribute('style') ?? '')
  const st: State = {
    lossy: [],
    defaultFamily: normFont(bodyStyle['font-family']),
    defaultSize: (bodyStyle['font-size'] ?? '').toLowerCase(),
  }
  const positioned: MappedBox[] = []
  const loose: Node[] = []
  for (const child of Array.from(body.childNodes)) {
    const style = child.nodeType === 1 ? parseStyle((child as Element).getAttribute('style') ?? '') : {}
    if (style.position !== 'absolute') {
      loose.push(child)
      continue
    }
    const blocks = blocksOfNodes([child], [], st)
    if (blocks.length > 0) positioned.push({ x: px(style.left) ?? 0, y: px(style.top) ?? 0, width: px(style.width) ?? DEFAULT_WIDTH, blocks })
  }
  const shift = positioned.length > 0 ? Math.min(...positioned.map((b) => b.y)) - TOP_MARGIN : 0
  for (const box of positioned) box.y -= shift
  positioned.sort((a, b) => a.y - b.y || a.x - b.x)
  const looseBlocks = blocksOfNodes(loose, [], st)
  if (looseBlocks.length > 0) {
    const y = positioned.length > 0 ? Math.max(...positioned.map((b) => b.y)) + LOOSE_GAP : TOP_MARGIN
    positioned.push({ x: LOOSE_X, y, width: DEFAULT_WIDTH, blocks: looseBlocks })
  }
  return { title, boxes: positioned, lossy: st.lossy }
}
