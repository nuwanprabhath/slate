import { NOTEBOOK_SCOPE, type Access, type NotebookDoc, type TreeItem } from '@slate/core'
import type { MenuItem } from './ContextMenu'

const OPTIONS: Array<{ access: Access | null; label: string }> = [
  { access: null, label: 'No AI access' },
  { access: 'read', label: 'AI can read' },
  { access: 'readwrite', label: 'AI can read & write' },
]

/** Context-menu entries that set the explicit AI grant on a node or on the whole notebook. */
export function accessItems(nb: NotebookDoc, target: TreeItem['id'] | typeof NOTEBOOK_SCOPE): MenuItem[] {
  const current = nb.accessOf(target)
  return OPTIONS.map((o) => ({ label: o.label, checked: current === o.access, onSelect: () => nb.setAccess(target, o.access) }))
}

export function accessTitle(access: Access): string {
  return access === 'readwrite' ? 'Shared with AI agents: read & write' : 'Shared with AI agents: read only'
}
