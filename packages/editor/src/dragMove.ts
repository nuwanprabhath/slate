import { Extension } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import { dropPoint } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import type { PMJSON } from '@slate/core'
import type { PageSession } from './PageSession'

type UndoSteps = Pick<PageSession, 'oneUndoStep'>

/**
 * The box editor a drag of its content (a clicked picture, selected text) started in, while it lasts.
 * ProseMirror moves a drop within one editor; dropped in another box or on the canvas it would only
 * copy, or do nothing, where OneNote moves.
 */
let source: EditorView | null = null

/** Alt (Option) on macOS, Ctrl elsewhere, held at the drop copies instead, as ProseMirror does within one box. */
const copies = (e: DragEvent) => (navigator.platform.startsWith('Mac') ? e.altKey : e.ctrlKey)

/** Another box's drag over the canvas: the canvas accepts it, to make a box there. */
export function boxContentDragged(): boolean {
  return source !== null && !source.isDestroyed && source.dragging !== null
}

/**
 * Removes what `view` drags from it. A picture dragged without being clicked first is not the
 * selection: ProseMirror keeps it as the drag's (untyped) `node`, a node selection.
 */
function removeDragged(view: EditorView): void {
  const dragging: object | null = view.dragging
  const tr = view.state.tr
  if (dragging && 'node' in dragging && dragging.node instanceof NodeSelection) dragging.node.replace(tr)
  else tr.deleteSelection()
  view.dispatch(tr.setMeta('uiEvent', 'drop'))
}

/** Drops the dragged content in a new box at `at` (canvas coordinates), moving it unless the copy modifier is held. */
export function dropInNewBox(session: PageSession, event: DragEvent, at: { x: number; y: number }): boolean {
  const from = source
  if (!from?.dragging || from.isDestroyed) return false
  const blocks = from.dragging.slice.content.toJSON() as PMJSON[]
  session.oneUndoStep(() => {
    session.createBoxWithContent(at.x, at.y, blocks)
    if (!copies(event)) removeDragged(from)
  })
  return true
}

/** Inserts what `from` drags at the drop point in `view`, then removes it from `from`: one undo step. */
function dropFromOtherBox(view: EditorView, from: EditorView, event: DragEvent, undo: UndoSteps | null): boolean {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!at || !from.dragging) return false
  // Each box editor has its own schema: a node from another box fits nowhere until it is remade in this one.
  const slice = Slice.fromJSON(view.state.schema, from.dragging.slice.toJSON())
  const pos = dropPoint(view.state.doc, at.pos, slice) ?? at.pos
  const node = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1 ? slice.content.firstChild : null
  const tr = view.state.tr
  if (node) tr.replaceRangeWith(pos, pos, node)
  else tr.replaceRange(pos, pos, slice)
  if (tr.doc.eq(view.state.doc)) return true
  const $pos = tr.doc.resolve(pos)
  if (node && NodeSelection.isSelectable(node) && $pos.nodeAfter?.sameMarkup(node)) tr.setSelection(new NodeSelection($pos))
  else tr.setSelection(TextSelection.between($pos, tr.doc.resolve(tr.mapping.map(pos))))
  const change = () => {
    view.dispatch(tr.setMeta('uiEvent', 'drop'))
    if (!copies(event)) removeDragged(from)
  }
  if (undo) undo.oneUndoStep(change)
  else change()
  view.focus()
  return true
}

/** Dragging a picture or text out of one box moves it into another box, or into a new box on the canvas. */
export const DragMove = Extension.create<{ session: UndoSteps | null }>({
  name: 'dragMove',
  addOptions: () => ({ session: null }),
  addProseMirrorPlugins() {
    const { session } = this.options
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            dragstart: (view) => {
              source = view
              return false
            },
            dragend: (view) => {
              if (source === view) source = null
              return false
            },
          },
          handleDrop: (view, event) => {
            const from = source
            if (!from || from === view || !boxContentDragged()) return false
            return dropFromOtherBox(view, from, event, session)
          },
        },
      }),
    ]
  },
})
