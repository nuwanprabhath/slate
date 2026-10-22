import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { compileQuery, matchAll, type FindOptions, type PageDoc } from '@slate/core'
import { loadBoxNode } from './staticRender'

export { compileQuery, findMatches, type FindOptions } from '@slate/core'

/** A match inside one box, in that box's ProseMirror positions. */
export interface FindMatch {
  boxId: string
  from: number
  to: number
}


/** Matches in a box's doc, per text block (they never cross block boundaries, like VS Code lines). */
export function findInDoc(doc: PMNode, query: string, opts: FindOptions): Array<{ from: number; to: number }> {
  const re = compileQuery(query, opts)
  if (!re) return []
  const out: Array<{ from: number; to: number }> = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // Inline leaves (hard breaks) are one position wide, so one placeholder character keeps offsets aligned.
    let text = ''
    node.forEach((child) => (text += child.isText ? child.text! : '￼'))
    for (const [from, to] of matchAll(text, re, opts.wholeWord)) out.push({ from: pos + 1 + from, to: pos + 1 + to })
    return false
  })
  return out
}

/** Every box on the page, private ones too (the flag only hides boxes from AI), in reading order. */
export function findInPage(page: PageDoc, schema: Schema, query: string, opts: FindOptions): FindMatch[] {
  if (!compileQuery(query, opts)) return []
  const boxes = [...page.listBoxes()].sort((a, b) => a.y - b.y || a.x - b.x)
  return boxes.flatMap((box) => {
    const node = loadBoxNode(schema, page.doc, box.contentId)
    return node ? findInDoc(node, query, opts).map((r) => ({ boxId: box.id, ...r })) : []
  })
}

type BoxHighlight = { from: number; to: number; current: boolean }

let byBox = new Map<string, BoxHighlight[]>()
const listeners = new Set<() => void>()

/** The highlights on screen. Empty while the find bar is closed. */
export const findStore = {
  setMatches(matches: FindMatch[], current: number): void {
    byBox = new Map()
    matches.forEach((m, i) => {
      const list = byBox.get(m.boxId) ?? []
      list.push({ from: m.from, to: m.to, current: i === current })
      byBox.set(m.boxId, list)
    })
    listeners.forEach((l) => l())
  },
  forBox: (boxId: string): BoxHighlight[] => byBox.get(boxId) ?? [],
  hasMatches: (boxId: string): boolean => byBox.has(boxId),
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

const key = new PluginKey<DecorationSet>('slateFind')

function build(boxId: string, doc: PMNode): DecorationSet {
  const list = findStore.forBox(boxId)
  if (list.length === 0) return DecorationSet.empty
  const size = doc.content.size
  return DecorationSet.create(
    doc,
    list
      .filter((h) => h.to <= size)
      .map((h) => Decoration.inline(h.from, h.to, { class: h.current ? 'slate-find-match slate-find-current' : 'slate-find-match' }, { current: h.current })),
  )
}

/**
 * Highlights the box's find matches as decorations, so they never touch the doc or undo history.
 * With no matches the state stays DecorationSet.empty and the store never notifies: no keystroke cost.
 */
export function findHighlightPlugin(boxId: string): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => build(boxId, state.doc),
      // An editor starts empty and loro-prosemirror fills it, so an empty set rebuilds on the first content.
      apply: (tr, old) =>
        tr.getMeta(key) || (tr.docChanged && old === DecorationSet.empty) ? build(boxId, tr.doc) : tr.docChanged ? old.map(tr.mapping, tr.doc) : old,
    },
    props: { decorations: (state) => key.getState(state) },
    view: (view) => ({ destroy: findStore.subscribe(() => view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false))) }),
  })
}
findHighlightPlugin.key = key
findHighlightPlugin.decorations = (state: EditorState): DecorationSet => key.getState(state) ?? DecorationSet.empty
