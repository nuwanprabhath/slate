import type { NodeKind, TreeItem } from '@slate/core'

export function findItem(items: TreeItem[], id: string | null): TreeItem | undefined {
  if (!id) return undefined
  for (const item of items) {
    if (item.id === id) return item
    const found = findItem(item.children, id)
    if (found) return found
  }
  return undefined
}

export function firstOfKind(items: TreeItem[], kind: NodeKind): TreeItem | undefined {
  for (const item of items) {
    if (item.kind === kind) return item
    const found = firstOfKind(item.children, kind)
    if (found) return found
  }
  return undefined
}

export const cls = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ')
