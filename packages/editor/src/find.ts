import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { applyReplace, compileQuery, matchAll, planReplace, rehearseReplace, type FindOptions, type PageDoc, type PlannedEdit, type ReplaceOptions } from '@slate/core'
import { loadBoxNode } from './staticRender'

export { compileQuery, expandReplacement, findMatches, preserveCaseOf, type FindOptions } from '@slate/core'

/**
 * How to replace: Preserve Case, which matches (all when `only` is absent), and how matches are
 * numbered: as the find bar counts them (the default) or as Find in Notes' index does.
 */
export type ReplaceChoice = Partial<Pick<ReplaceOptions, 'preserveCase' | 'only'>> & { numbering?: 'find-bar' | 'search-index' }

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

/**
 * A mounted box editor's loro-prosemirror binding ignores local commits unless their origin is
 * "undo" (it assumes a local change came from that editor). A replace is local, so it may be undone,
 * and uses that origin so every mounted editor redraws it; the UndoManager records it like any edit.
 */
const REDRAW_ORIGIN = 'undo'
const ABORT_ORIGIN = 'sys:replace-aborted'

/**
 * Replaces matches in the page's boxes and commits once, so it is one undo step. The one place that
 * edits text for find and replace, whether the page is on screen or only loaded to be changed.
 */
export function replaceInPageDoc(page: PageDoc, schema: Schema, query: string, opts: FindOptions, replacement: string, choice: ReplaceChoice): PlannedEdit[] {
  // The text styles loro-prosemirror configures, so a page with no editor mounted marks text the same way.
  const styles = Object.fromEntries(Object.entries(schema.marks).map(([name, type]) => [name, { expand: type.spec.inclusive === false ? ('none' as const) : ('after' as const) }]))
  page.doc.configTextStyle(styles)
  // Reading only: a throw here has written nothing.
  const edits = planReplace(page, query, opts, replacement, {
    preserveCase: choice.preserveCase ?? false,
    ...(choice.only ? { only: choice.only } : {}),
    ...(choice.numbering === 'search-index' ? {} : { isTextblock: (name: string) => schema.nodes[name]?.isTextblock ?? false }),
  })
  if (edits.length === 0) return edits
  // On a fork first: a write that throws does so there, and the page has nothing pending to save.
  rehearseReplace(page.doc, edits, styles)
  const before = page.doc.frontiers()
  try {
    applyReplace(edits)
  } catch (err) {
    // Unreachable unless the same writes behave differently on the page than on its fork. Then the
    // only way not to leave half a replace pending for the next commit is to commit it with its
    // reversal under a sys:* origin (no undo step).
    page.doc.commit({ origin: ABORT_ORIGIN })
    page.doc.revertTo(before)
    page.doc.commit({ origin: ABORT_ORIGIN })
    throw err
  }
  page.doc.commit({ origin: REDRAW_ORIGIN })
  return edits
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
