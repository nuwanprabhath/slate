import { LoroList, LoroMap, LoroText, type Value } from 'loro-crdt'
import type { PMJSON } from './plaintext'

// The layout loro-prosemirror uses (its NODE_NAME_KEY, ATTRIBUTES_KEY, CHILDREN_KEY). Core reads
// and writes it without ProseMirror, so agents and the CLI need no editor code.
const NODE_NAME = 'nodeName'
const ATTRIBUTES = 'attributes'
const CHILDREN = 'children'

function writeNode(map: LoroMap, node: PMJSON): void {
  map.set(NODE_NAME, node.type)
  const attrs = map.setContainer(ATTRIBUTES, new LoroMap())
  for (const [key, value] of Object.entries(node.attrs ?? {})) if (value !== undefined) attrs.set(key, value as Value)
  const children = map.setContainer(CHILDREN, new LoroList())
  for (const child of node.content ?? []) {
    if (child.type === 'text') children.insertContainer(children.length, new LoroText()).insert(0, child.text ?? '')
    else writeNode(children.insertContainer(children.length, new LoroMap()), child)
  }
}

/**
 * Writes block content straight into an empty box content container, in the layout
 * loro-prosemirror uses. For boxes created without a mounted editor (paste on empty canvas,
 * test seeding, agents). Marks are not written. Caller commits.
 */
export function writeContent(root: LoroMap, blocks: PMJSON[]): void {
  writeNode(root, { type: 'doc', content: blocks })
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
