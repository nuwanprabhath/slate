import { Extension } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state'
import { dropPoint } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import type { PMJSON } from '@slate/core'
import { posFromEmptySpace } from './emptySpace'
import type { PageSession } from './PageSession'

type UndoSteps = Pick<PageSession, 'oneUndoStep' | 'deleteIfEmptied'>

/**
 * The box editor a drag of its content (a clicked picture, selected text) started in, while it lasts.
 * ProseMirror moves a drop within one editor; dropped in another box or on the canvas it would only
 * copy, or do nothing, where OneNote moves.
 */
let source: { view: EditorView; boxId: string | null } | null = null

/** Alt (Option) on macOS, Ctrl elsewhere, held at the drop copies instead, as ProseMirror does within one box. */
const copies = (e: DragEvent) => (navigator.platform.startsWith('Mac') ? e.altKey : e.ctrlKey)

/** Another box's drag over the canvas: the canvas accepts it, to make a box there. */
export function boxContentDragged(): boolean {
  return source !== null && !source.view.isDestroyed && source.view.dragging !== null
}

/**
 * Takes what `view` drags out of `tr`. A picture dragged without being clicked first is not the
 * selection: ProseMirror keeps it as the drag's (untyped) `node`, a node selection.
 */
function cutDragged(view: EditorView, tr: Transaction): void {
  const dragging: object | null = view.dragging
  if (dragging && 'node' in dragging && dragging.node instanceof NodeSelection) dragging.node.replace(tr)
  else tr.deleteSelection()
}

function removeDragged({ view, boxId }: NonNullable<typeof source>, undo: UndoSteps | null): void {
  const tr = view.state.tr
  cutDragged(view, tr)
  view.dispatch(tr.setMeta('uiEvent', 'drop'))
  if (boxId) undo?.deleteIfEmptied(boxId)
}

/** Drops the dragged content in a new box at `at` (canvas coordinates), moving it unless the copy modifier is held. */
export function dropInNewBox(session: PageSession, event: DragEvent, at: { x: number; y: number }): boolean {
  const from = source
  if (!from?.view.dragging || from.view.isDestroyed) return false
  const blocks = from.view.dragging.slice.content.toJSON() as PMJSON[]
  session.oneUndoStep(() => {
    session.createBoxWithContent(at.x, at.y, blocks)
    if (!copies(event)) removeDragged(from, session)
  })
  return true
}

/**
 * Puts what `from` drags at `at` in `view` (moved unless the copy modifier is held): one undo step.
 * Within one box it is the same move ProseMirror makes, for drops it does not see (the box's empty space).
 */
function dropAt(view: EditorView, at: number, from: NonNullable<typeof source>, event: DragEvent, undo: UndoSteps | null): boolean {
  if (!from.view.dragging) return false
  const same = from.view === view
  const move = !copies(event)
  // Each box editor has its own schema: a node from another box fits nowhere until it is remade in this one.
  const slice = same ? from.view.dragging.slice : Slice.fromJSON(view.state.schema, from.view.dragging.slice.toJSON())
  const tr = view.state.tr
  if (same && move) cutDragged(view, tr)
  const mapped = tr.mapping.map(at)
  const pos = dropPoint(tr.doc, mapped, slice) ?? mapped
  const node = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1 ? slice.content.firstChild : null
  const before = tr.doc
  if (node) tr.replaceRangeWith(pos, pos, node)
  else tr.replaceRange(pos, pos, slice)
  if (tr.doc.eq(before)) return true
  const $pos = tr.doc.resolve(pos)
  if (node && NodeSelection.isSelectable(node) && $pos.nodeAfter?.sameMarkup(node)) tr.setSelection(new NodeSelection($pos))
  else tr.setSelection(TextSelection.between($pos, tr.doc.resolve(tr.mapping.slice(tr.mapping.maps.length - 1).map(pos))))
  const change = () => {
    view.dispatch(tr.setMeta('uiEvent', 'drop'))
    if (!same && move) removeDragged(from, undo)
  }
  if (undo) undo.oneUndoStep(change)
  else change()
  view.focus()
  return true
}

/** A drag over a box's empty space (outside its editor): the box accepts it, to drop at the nearest text. */
export function dropInEmptySpace(view: EditorView, x: number, y: number, event: DragEvent, undo: UndoSteps | null): boolean {
  const from = source
  if (!from || !boxContentDragged()) return false
  return dropAt(view, posFromEmptySpace(view, x, y), from, event, undo)
}

/** Dragging a picture or text out of one box moves it into another box, or into a new box on the canvas. */
export const DragMove = Extension.create<{ session: UndoSteps | null; boxId: string | null }>({
  name: 'dragMove',
  addOptions: () => ({ session: null, boxId: null }),
  addProseMirrorPlugins() {
    const { session, boxId } = this.options
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            dragstart: (view) => {
              source = { view, boxId }
              return false
            },
            dragend: (view) => {
              if (source?.view === view) source = null
              return false
            },
          },
          handleDrop: (view, event) => {
            const from = source
            if (!from || from.view === view || !boxContentDragged()) return false
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
            return at ? dropAt(view, at.pos, from, event, session) : false
          },
        },
      }),
    ]
  },
})
