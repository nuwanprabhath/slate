import { Extension } from '@tiptap/core'
import { NodeRange } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    slateMoveBlocks: { moveBlocks: (dir: 'up' | 'down') => ReturnType }
  }
}

/** The blocks the selection covers; in a list, the whole items (with their children). */
function movableRange(state: EditorState): NodeRange | null {
  const { $from, $to } = state.selection
  let range = $from.blockRange($to)
  while (range && range.parent.type.name === 'listItem' && range.depth > 0) range = new NodeRange($from, $to, range.depth - 1)
  return range
}

/**
 * Swaps the covered blocks with their neighbour above or below, inside the same parent (so never out
 * of the box, a list or a table cell). One transaction, so one undo step.
 */
export function moveBlocks(state: EditorState, tr: Transaction, dir: 'up' | 'down'): boolean {
  const range = movableRange(state)
  if (!range) return false
  if (dir === 'up') {
    if (range.startIndex === 0) return true
    const prev = range.parent.child(range.startIndex - 1)
    tr.delete(range.start - prev.nodeSize, range.start)
    tr.insert(range.end - prev.nodeSize, prev)
  } else {
    if (range.endIndex >= range.parent.childCount) return true
    const next = range.parent.child(range.endIndex)
    tr.delete(range.end, range.end + next.nodeSize)
    tr.insert(range.start, next)
  }
  tr.scrollIntoView()
  return true
}

export const MoveBlocks = Extension.create({
  name: 'moveBlocks',
  addCommands() {
    return {
      moveBlocks:
        (dir) =>
        ({ state, tr, dispatch }) =>
          dispatch ? moveBlocks(state, tr, dir) : movableRange(state) !== null,
    }
  },
  addKeyboardShortcuts() {
    return {
      'Alt-Shift-ArrowUp': () => this.editor.commands.moveBlocks('up'),
      'Alt-Shift-ArrowDown': () => this.editor.commands.moveBlocks('down'),
    }
  },
})
