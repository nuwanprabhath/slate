import { DOMSerializer, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { LoroMap, type ContainerID, type LoroDoc } from 'loro-crdt'
import { createNodeFromLoroObj, type LoroNode } from 'loro-prosemirror'

/** A box's content as a ProseMirror doc, read straight from Loro without an editor. Null when empty. */
export function loadBoxNode(schema: Schema, doc: LoroDoc, contentId: ContainerID): PMNode | null {
  const map = doc.getContainerById(contentId)
  if (!(map instanceof LoroMap) || map.size === 0) return null
  return createNodeFromLoroObj(schema, map as unknown as LoroNode, new Map())
}

/** Renders a box's content without an editor (used for off-screen boxes). Null when empty. */
export function renderStaticHtml(schema: Schema, doc: LoroDoc, contentId: ContainerID, document: Document): DocumentFragment | null {
  const node = loadBoxNode(schema, doc, contentId)
  return node && (DOMSerializer.fromSchema(schema).serializeFragment(node.content, { document }) as DocumentFragment)
}
