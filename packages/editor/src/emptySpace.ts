import { Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * A press in a box's empty space (a box made taller than its text) lands outside the editor, where
 * the browser moves a shift+click selection to the box's start. The point maps to the nearest text
 * position instead: below the text its end, above it its start, beside a line that line.
 */
export function selectFromEmptySpace(view: EditorView, x: number, y: number, extend: boolean): void {
  const { doc } = view.state
  const first = view.dom.firstElementChild?.getBoundingClientRect()
  const last = view.dom.lastElementChild?.getBoundingClientRect()
  const area = view.dom.getBoundingClientRect()
  const end = Selection.atEnd(doc).head
  let head: number
  if (!last || y >= last.bottom) head = end
  else if (first && y <= first.top) head = Selection.atStart(doc).head
  else head = view.posAtCoords({ left: Math.min(Math.max(x, area.left + 1), area.right - 1), top: y })?.pos ?? end
  const anchor = extend ? liveAnchor(view) : head
  view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head))))
  view.focus()
}

/** The selection's anchor as the browser has it now: the editor reads a mouse selection a moment later. */
function liveAnchor(view: EditorView): number {
  const dom = view.dom.ownerDocument.getSelection()
  if (dom?.anchorNode && view.dom.contains(dom.anchorNode)) {
    try {
      return view.posAtDOM(dom.anchorNode, dom.anchorOffset)
    } catch {
      // A node ProseMirror does not map (a widget): fall back to the editor's own selection.
    }
  }
  return view.state.selection.anchor
}
