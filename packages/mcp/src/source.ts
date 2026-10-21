import type { NotebookDoc, PageDoc } from '@slate/core'

export interface NotebookRef {
  id: string
  doc: NotebookDoc
}

export type AuditOutcome = 'ok' | 'denied' | 'not-found'

export interface AuditEntry {
  tool: string
  target: string
  outcome: AuditOutcome
}

/** Where tools read and write. Doc ids: `notebook:<id>`, `page:<pageId>` (as in the desktop store). */
export interface DocSource {
  notebooks(): Promise<NotebookRef[]>
  loadPage(pageId: string): Promise<PageDoc>
  save(docId: string, update: Uint8Array): Promise<void>
  audit(entry: AuditEntry): Promise<void>
}
