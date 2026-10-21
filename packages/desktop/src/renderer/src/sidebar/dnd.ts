import type { DragEvent } from 'react'
import type { NotebookDoc, TreeItem } from '@slate/core'

export const DRAG_MIME = 'application/x-slate-node'
export type DropZone = 'before' | 'after' | 'inside'
/** Loro's branded tree id; core does not re-export it, so derive it. */
export type NodeId = TreeItem['id']

export function dropZone(e: DragEvent<HTMLElement>, allowInside: boolean): DropZone {
  const rect = e.currentTarget.getBoundingClientRect()
  const f = (e.clientY - rect.top) / rect.height
  if (allowInside && f > 0.25 && f < 0.75) return 'inside'
  return f < 0.5 ? 'before' : 'after'
}

export function applyDrop(nb: NotebookDoc, draggedId: NodeId, target: TreeItem, zone: DropZone): void {
  if (draggedId === target.id) return
  try {
    if (zone === 'inside') nb.moveInto(draggedId, target.id)
    else if (zone === 'before') nb.moveBefore(draggedId, target.id)
    else nb.moveAfter(draggedId, target.id)
  } catch {
    // Invalid placement (e.g. a page dropped beside a section, a group into itself): leave the tree unchanged.
  }
}
