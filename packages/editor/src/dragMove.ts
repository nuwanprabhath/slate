import { Extension } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state'
import { dropPoint } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import type { PMJSON } from '@slate/core'
import { posFromEmptySpace } from './emptySpace'
import { floatPosition } from './floatImages'
import type { PageSession } from './PageSession'

type UndoSteps = Pick<PageSession, 'oneUndoStep' | 'deleteIfEmptied'>

/**
 * The box editor a drag of its content (a clicked picture, selected text) started in, while it lasts.
 * ProseMirror moves a drop within one editor; dropped in another box or on the canvas it would only
 * copy, or do nothing, where OneNote moves.
 */
let source: { view: EditorView; boxId: string | null; grab: { x: number; y: number } | null } | null = null

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

/** The one picture `view` drags, if that is what it drags. */
function draggedPicture(view: EditorView): { pos: number; node: PMNode; dom: HTMLElement } | null {
  const dragging: object | null = view.dragging
  const sel = dragging && 'node' in dragging && dragging.node instanceof NodeSelection ? dragging.node : view.state.selection
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return null
  const dom = view.nodeDOM(sel.from)
  return dom instanceof HTMLElement ? { pos: sel.from, node: sel.node, dom } : null
}

/** Where a dragged picture lands in `view`'s box: the spot it was let go at, held where it was grabbed. */
function placeIn(view: EditorView, from: NonNullable<typeof source>, event: DragEvent): { x: number; y: number } | null {
  const picture = from.grab ? draggedPicture(from.view) : null
  if (!picture || !from.grab) return null
  const rect = view.dom.getBoundingClientRect()
  const area = { left: rect.left + view.dom.clientLeft, top: rect.top + view.dom.clientTop, width: view.dom.clientWidth }
  return floatPosition({ x: event.clientX, y: event.clientY }, from.grab, area, picture.dom.offsetWidth)
}

function removeDragged({ view, boxId }: NonNullable<typeof source>, undo: UndoSteps | null): void {
  const tr = view.state.tr
  cutDragged(view, tr)
  view.dispatch(tr.setMeta('uiEvent', 'drop'))
  if (boxId) undo?.deleteIfEmptied(boxId)
}

/** `.slate-box`'s border width in canvas.css. */
const BOX_BORDER = 1

/** Drops the dragged content in a new box at `at` (canvas coordinates), moving it unless the copy modifier is held. */
export function dropInNewBox(session: PageSession, event: DragEvent, at: { x: number; y: number }): boolean {
  const from = source
  if (!from?.view.dragging || from.view.isDestroyed) return false
  // A floating picture starts the new box in its text: its place belonged to the old box.
  const blocks = (from.view.dragging.slice.content.toJSON() as PMJSON[]).map((b) => (b.type === 'image' ? { ...b, attrs: { ...b.attrs, x: null, y: null } } : b))
  // A picture lands where it was let go, held where it was grabbed: the box goes up and left of it
  // by the grab and the box's own edge (border and the content's padding).
  let { x, y } = at
  if (from.grab && draggedPicture(from.view)) {
    const style = getComputedStyle(from.view.dom)
    x = Math.max(0, Math.round(x - from.grab.x - BOX_BORDER - (parseFloat(style.paddingLeft) || 0)))
    y = Math.max(0, Math.round(y - from.grab.y - BOX_BORDER - (parseFloat(style.paddingTop) || 0)))
  }
  session.oneUndoStep(() => {
    session.createBoxWithContent(x, y, blocks)
    if (!copies(event)) removeDragged(from, session)
  })
  return true
}

/**
 * Puts what `from` drags at `at` in `view` (moved unless the copy modifier is held): one undo step.
 * Text goes into the text, as ProseMirror's own drop puts it. A picture floats where it was let go
 * (floatImages.ts), as in OneNote; moved within its own box, only its place changes.
 */
function dropAt(view: EditorView, at: number, from: NonNullable<typeof source>, event: DragEvent, undo: UndoSteps | null): boolean {
  if (!from.view.dragging) return false
  const same = from.view === view
  const move = !copies(event)
  // Each box editor has its own schema: a node from another box fits nowhere until it is remade in this one.
  let slice = same ? from.view.dragging.slice : Slice.fromJSON(view.state.schema, from.view.dragging.slice.toJSON())
  const place = placeIn(view, from, event)
  const picture = place ? draggedPicture(from.view) : null
  const tr = view.state.tr
  if (same && move && picture && place) {
    tr.setNodeMarkup(picture.pos, undefined, { ...picture.node.attrs, ...place }).setSelection(NodeSelection.create(tr.doc, picture.pos))
    const change = () => view.dispatch(tr.setMeta('uiEvent', 'drop'))
    if (undo) undo.oneUndoStep(change)
    else change()
    view.focus()
    return true
  }
  const first = slice.content.firstChild
  if (place && first) slice = new Slice(Fragment.from(first.type.create({ ...first.attrs, ...place }, first.content, first.marks)), 0, 0)
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
            dragstart: (view, event) => {
              const rect = event.target instanceof HTMLImageElement ? event.target.getBoundingClientRect() : null
              source = { view, boxId, grab: rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null }
              return false
            },
            dragend: (view) => {
              if (source?.view === view) source = null
              return false
            },
          },
          handleDrop: (view, event) => {
            const from = source
            if (!from || !boxContentDragged()) return false
            // Text dragged within its box is ProseMirror's own move.
            if (from.view === view && !placeIn(view, from, event)) return false
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
            return at ? dropAt(view, at.pos, from, event, session) : false
          },
        },
      }),
    ]
  },
})
