import type { Access, AgentPage, NotebookDoc, PMJSON, TreeItem } from '@slate/core'

/** A notebook as plain data: what listing and permission checks read, with no document behind it. */
export interface NotebookView {
  id: string
  name: string
  items: TreeItem[]
  /** Each item's effective (inherited) access, by item id; an item with none is absent. */
  access: ReadonlyMap<string, Access>
}

/** Reads a notebook doc into its `NotebookView`, which outlives the doc. */
export function notebookView(id: string, doc: NotebookDoc): NotebookView {
  const items = doc.items()
  const access = new Map<string, Access>()
  const walk = (list: TreeItem[]): void => {
    for (const item of list) {
      const a = doc.effectiveAccess(item.id)
      if (a) access.set(item.id, a)
      walk(item.children)
    }
  }
  walk(items)
  return { id, name: doc.name, items, access }
}

export type AuditOutcome = 'ok' | 'denied' | 'not-found'

export interface AuditEntry {
  tool: string
  target: string
  outcome: AuditOutcome
}

/**
 * Where tools read and write. Doc ids: `notebook:<id>`, `page:<pageId>` (as in the desktop store).
 *
 * A page never crosses this line as a `PageDoc`: `readPage` hands back the redacted projection, and
 * the two writes happen on the source side, so `agentBoxes` and `placeBelow` are the only way a box's
 * content is ever read and the private-box rule cannot be skipped by a tool that forgets to call it.
 */
export interface DocSource {
  notebooks(): Promise<NotebookView[]>
  /**
   * Lends the live notebook doc to `fn`, for a write. The doc is valid until `fn`'s promise settles and
   * not after: the source frees it once it is both out of the cache and no longer lent. Resolves null,
   * without calling `fn`, when there is no such notebook.
   */
  withNotebook<T>(notebookId: string, fn: (doc: NotebookDoc) => Promise<T>): Promise<T | null>
  readPage(pageId: string): Promise<AgentPage>
  /** Adds a box below the existing ones and persists the page. */
  appendBox(pageId: string, blocks: PMJSON[]): Promise<{ boxId: string }>
  /** Writes a fresh page doc, with one box when `blocks` is given. */
  createPage(pageId: string, blocks: PMJSON[] | null): Promise<void>
  /** For the notebook doc only; page writes go through `appendBox`/`createPage`. */
  save(docId: string, update: Uint8Array): Promise<void>
  audit(entry: AuditEntry): Promise<void>
}
