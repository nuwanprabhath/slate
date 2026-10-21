import { LoroList, LoroMap, LoroText, type LoroDoc, type Value } from 'loro-crdt'
import type { PMJSON } from './plaintext'

// The layout loro-prosemirror uses (its NODE_NAME_KEY, ATTRIBUTES_KEY, CHILDREN_KEY). Core reads
// and writes it without ProseMirror, so agents and the CLI need no editor code.
const NODE_NAME = 'nodeName'
const ATTRIBUTES = 'attributes'
const CHILDREN = 'children'

// ProseMirror's `inclusive: false` marks: typing at their edge must not extend them.
const NON_INCLUSIVE = new Set(['link', 'code'])

function collectMarkTypes(node: PMJSON, into: Set<string>): void {
  for (const child of node.content ?? []) {
    for (const m of child.marks ?? []) into.add(m.type)
    collectMarkTypes(child, into)
  }
}

// Consecutive text nodes share one LoroText, as loro-prosemirror stores them. A mark's value is
// its attrs object ({} when it has none), what nodeMarksToAttributes writes.
function writeTextRuns(children: LoroList, runs: PMJSON[]): void {
  const text = children.insertContainer(children.length, new LoroText())
  let at = 0
  const marks: Array<{ start: number; end: number; type: string; attrs: Record<string, unknown> }> = []
  for (const run of runs) {
    const value = run.text ?? ''
    text.insert(at, value)
    for (const m of run.marks ?? []) marks.push({ start: at, end: at + value.length, type: m.type, attrs: m.attrs ?? {} })
    at += value.length
  }
  for (const m of marks) if (m.end > m.start) text.mark({ start: m.start, end: m.end }, m.type, m.attrs as Value)
}

function writeNode(map: LoroMap, node: PMJSON): void {
  map.set(NODE_NAME, node.type)
  const attrs = map.setContainer(ATTRIBUTES, new LoroMap())
  for (const [key, value] of Object.entries(node.attrs ?? {})) if (value !== undefined) attrs.set(key, value as Value)
  const children = map.setContainer(CHILDREN, new LoroList())
  const content = node.content ?? []
  for (let i = 0; i < content.length; i++) {
    if (content[i].type !== 'text') {
      writeNode(children.insertContainer(children.length, new LoroMap()), content[i])
      continue
    }
    let end = i
    while (end + 1 < content.length && content[end + 1].type === 'text') end++
    writeTextRuns(children, content.slice(i, end + 1))
    i = end
  }
}

/**
 * Writes block content straight into an empty box content container, in the layout
 * loro-prosemirror uses. For boxes created without a mounted editor (paste on empty canvas,
 * test seeding, agents, import). Caller commits. Loro containers cannot reach their doc, so pass
 * it: each used mark's text style is configured on it (without that, typing at a mark's edge
 * ignores ProseMirror's inclusive rules).
 */
export function writeContent(root: LoroMap, blocks: PMJSON[], doc?: LoroDoc): void {
  const page: PMJSON = { type: 'doc', content: blocks }
  const used = new Set<string>()
  collectMarkTypes(page, used)
  if (doc && used.size > 0) {
    const styles: Record<string, { expand: 'none' | 'after' }> = {}
    for (const type of used) styles[type] = { expand: NON_INCLUSIVE.has(type) ? 'none' : 'after' }
    doc.configTextStyle(styles)
  }
  writeNode(root, page)
}

function textToJSON(text: LoroText): PMJSON[] {
  return text.toDelta().flatMap((op) => {
    if (typeof op.insert !== 'string' || op.insert === '') return []
    const marks = Object.entries(op.attributes ?? {})
      .filter(([, v]) => v !== null && v !== undefined && v !== false)
      .map(([type, v]) => (typeof v === 'object' ? { type, attrs: v as Record<string, unknown> } : { type }))
    return [{ type: 'text', text: op.insert, ...(marks.length > 0 ? { marks } : {}) }]
  })
}

function nodeToJSON(map: LoroMap): PMJSON {
  const attrsMap = map.get(ATTRIBUTES)
  const attrs = attrsMap instanceof LoroMap ? (attrsMap.toJSON() as Record<string, unknown>) : {}
  const children = map.get(CHILDREN)
  const content: PMJSON[] = []
  if (children instanceof LoroList) {
    for (const child of children.toArray()) {
      if (child instanceof LoroText) content.push(...textToJSON(child))
      else if (child instanceof LoroMap) content.push(nodeToJSON(child))
    }
  }
  return { type: String(map.get(NODE_NAME)), ...(Object.keys(attrs).length > 0 ? { attrs } : {}), ...(content.length > 0 ? { content } : {}) }
}

/** ProseMirror-shaped JSON of a box's content, or null for an empty box. */
export function contentToJSON(root: LoroMap): PMJSON | null {
  return root.size === 0 ? null : nodeToJSON(root)
}
