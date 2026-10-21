import { DOMSerializer, type Schema } from '@tiptap/pm/model'
import { LoroMap, type ContainerID, type LoroDoc } from 'loro-crdt'
import { createNodeFromLoroObj, type LoroNode } from 'loro-prosemirror'

/** Renders a box's content without an editor (used for off-screen boxes). Null when empty. */
export function renderStaticHtml(schema: Schema, doc: LoroDoc, contentId: ContainerID, document: Document): DocumentFragment | null {
  const map = doc.getContainerById(contentId)
  if (!(map instanceof LoroMap) || map.size === 0) return null
  const node = createNodeFromLoroObj(schema, map as unknown as LoroNode, new Map())
  return DOMSerializer.fromSchema(schema).serializeFragment(node.content, { document }) as DocumentFragment
}
