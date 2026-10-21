import { LoroList, LoroMap, LoroText, type Value } from 'loro-crdt'
import { ATTRIBUTES_KEY, CHILDREN_KEY, NODE_NAME_KEY } from 'loro-prosemirror'
import type { PMJSON } from '@slate/core'

function writeNode(map: LoroMap, node: PMJSON): void {
  map.set(NODE_NAME_KEY, node.type)
  const attrs = map.setContainer(ATTRIBUTES_KEY, new LoroMap())
  for (const [key, value] of Object.entries(node.attrs ?? {})) if (value !== undefined) attrs.set(key, value as Value)
  const children = map.setContainer(CHILDREN_KEY, new LoroList())
  for (const child of node.content ?? []) {
    if (child.type === 'text') children.insertContainer(children.length, new LoroText()).insert(0, child.text ?? '')
    else writeNode(children.insertContainer(children.length, new LoroMap()), child)
  }
}

/**
 * Writes block content straight into an empty box content container, in the same layout
 * loro-prosemirror uses. For boxes created without a mounted editor (paste on empty canvas,
 * test seeding). Marks are not written. Caller commits.
 */
export function writeContent(root: LoroMap, blocks: PMJSON[]): void {
  writeNode(root, { type: 'doc', content: blocks })
}
