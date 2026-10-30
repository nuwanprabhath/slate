import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { loroSyncPluginKey } from 'loro-prosemirror'

/**
 * Folded headings: view state only, never in the document, so never synced. Kept in this renderer's
 * memory per box (not on disk: a heading's text would sit outside an encrypted vault). A fold is
 * the heading's position and text; once the heading there no longer has that text, it unfolds.
 */
interface Fold {
  pos: number
  text: string
  /** What it hides, as last drawn, so `unfoldAt` works from the store alone. */
  hideFrom: number
  hideTo: number
}

interface FoldState {
  folds: Fold[]
  deco: DecorationSet
}

type FoldMeta = { toggle: number } | { reload: true }

const byBox = new Map<string, Fold[]>()
const listeners = new Map<string, Set<() => void>>()
const key = new PluginKey<FoldState>('slateFold')

function notify(boxId: string): void {
  listeners.get(boxId)?.forEach((l) => l())
}

/** The siblings a heading hides: up to the next heading of the same or a higher level. */
function hiddenRange(doc: PMNode, pos: number, heading: PMNode): [number, number] {
  const $pos = doc.resolve(pos)
  const parent = $pos.parent
  const from = pos + heading.nodeSize
  let to = from
  for (let i = $pos.index() + 1; i < parent.childCount; i++) {
    const child = parent.child(i)
    if (child.type.name === 'heading' && (child.attrs.level as number) <= (heading.attrs.level as number)) break
    to += child.nodeSize
  }
  return [from, to]
}

function toggleDom(folded: boolean): () => HTMLElement {
  return () => {
    const el = document.createElement('span')
    el.className = 'slate-fold-toggle'
    el.contentEditable = 'false'
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', folded ? 'Unfold heading' : 'Fold heading')
    el.setAttribute('aria-expanded', String(!folded))
    el.title = folded ? 'Unfold' : 'Fold'
    // The ▸/▾ glyph is drawn by canvas.css, so the heading's text stays its own.
    return el
  }
}

/** Decorations for the folds that still match a heading, and those folds with their hidden ranges. */
function build(doc: PMNode, folds: Fold[], dropStale = false): FoldState {
  const decos: Decoration[] = []
  const live: Fold[] = []
  doc.forEach((node, pos) => {
    if (node.type.name !== 'heading') return
    const fold = folds.find((f) => f.pos === pos && f.text === node.textContent)
    decos.push(Decoration.widget(pos + 1, toggleDom(Boolean(fold)), { side: -1, key: fold ? 'fold-on' : 'fold-off', ignoreSelection: true }))
    if (!fold) return
    const [hideFrom, hideTo] = hiddenRange(doc, pos, node)
    live.push({ ...fold, hideFrom, hideTo })
    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'slate-folded' }))
    doc.nodesBetween(hideFrom, hideTo, (child, at) => {
      if (at >= hideFrom) decos.push(Decoration.node(at, at + child.nodeSize, { class: 'slate-fold-hidden' }))
      return false
    })
  })
  // Folds not drawn are kept unless a local edit made them stale: the doc may not be loaded yet.
  const stale = dropStale ? [] : folds.filter((f) => !live.some((l) => l.pos === f.pos))
  return { folds: [...live, ...stale], deco: DecorationSet.create(doc, decos) }
}

const inside = (f: Fold, pos: number) => pos >= f.hideFrom && pos < f.hideTo

export function foldPlugin(boxId: string): Plugin<FoldState> {
  return new Plugin<FoldState>({
    key,
    state: {
      init: (_, state) => build(state.doc, byBox.get(boxId) ?? []),
      apply(tr: Transaction, old: FoldState): FoldState {
        const meta = tr.getMeta(key) as FoldMeta | undefined
        const synced = Boolean(tr.getMeta(loroSyncPluginKey))
        if (!meta && !tr.docChanged && !(tr.selectionSet && old.folds.some((f) => inside(f, tr.selection.head)))) return old
        let folds = old.folds
        // Loro's own transactions (load, remote edit, undo) replace content wholesale: positions stay as stored.
        if (tr.docChanged && !synced) {
          folds = folds.flatMap((f) => {
            const mapped = tr.mapping.mapResult(f.pos)
            return mapped.deleted ? [] : [{ ...f, pos: mapped.pos }]
          })
        }
        if (meta && 'reload' in meta) folds = byBox.get(boxId) ?? []
        if (meta && 'toggle' in meta) {
          const node = tr.doc.nodeAt(meta.toggle)
          const on = folds.some((f) => f.pos === meta.toggle)
          folds = on ? folds.filter((f) => f.pos !== meta.toggle) : node ? [...folds, { pos: meta.toggle, text: node.textContent, hideFrom: 0, hideTo: 0 }] : folds
        }
        const dropStale = tr.docChanged && !synced
        let next = build(tr.doc, folds, dropStale)
        const opened = next.folds.filter((f) => !(tr.selectionSet && inside(f, tr.selection.head)))
        if (opened.length !== next.folds.length) next = build(tr.doc, opened, dropStale)
        byBox.set(boxId, next.folds)
        return next
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.deco,
      handleDOMEvents: {
        mousedown: (view, event) => {
          const toggle = event.target instanceof Element ? event.target.closest('.slate-fold-toggle') : null
          const heading = toggle?.parentElement
          if (!heading || event.button !== 0) return false
          event.preventDefault()
          toggleFold(view, view.posAtDOM(heading, 0) - 1)
          return true
        },
      },
    },
    view: (view) => {
      const reload = () => view.dispatch(view.state.tr.setMeta(key, { reload: true } satisfies FoldMeta))
      const set = listeners.get(boxId) ?? new Set()
      set.add(reload)
      listeners.set(boxId, set)
      return { destroy: () => set.delete(reload) }
    },
  })
}

/** Folds or unfolds the heading at `pos`; a caret inside what it hides moves to the heading's end. */
export function toggleFold(view: EditorView, pos: number): void {
  const heading = view.state.doc.nodeAt(pos)
  if (heading?.type.name !== 'heading') return
  const tr = view.state.tr.setMeta(key, { toggle: pos } satisfies FoldMeta)
  const [from, to] = hiddenRange(view.state.doc, pos, heading)
  const { head } = view.state.selection
  if (head >= from && head < to) tr.setSelection(TextSelection.create(tr.doc, pos + heading.nodeSize - 1))
  view.dispatch(tr)
}

/**
 * For find (WP-B): opens any fold in the box that hides `pos` (a position in that box's document).
 * Works whether or not the box's editor is mounted. Returns whether something was unfolded.
 */
export function unfoldAt(boxId: string, pos: number): boolean {
  const folds = byBox.get(boxId) ?? []
  const kept = folds.filter((f) => !inside(f, pos))
  if (kept.length === folds.length) return false
  byBox.set(boxId, kept)
  notify(boxId)
  return true
}
