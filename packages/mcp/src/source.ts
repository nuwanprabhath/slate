import type { AgentPage, NotebookDoc, PMJSON } from '@slate/core'

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

/**
 * Where tools read and write. Doc ids: `notebook:<id>`, `page:<pageId>` (as in the desktop store).
 *
 * A page never crosses this line as a `PageDoc`: `readPage` hands back the redacted projection, and
 * the two writes happen on the source side, so `agentBoxes` and `placeBelow` are the only way a box's
 * content is ever read and the private-box rule cannot be skipped by a tool that forgets to call it.
 */
export interface DocSource {
  notebooks(): Promise<NotebookRef[]>
  readPage(pageId: string): Promise<AgentPage>
  /** Adds a box below the existing ones and persists the page. */
  appendBox(pageId: string, blocks: PMJSON[]): Promise<{ boxId: string }>
  /** Writes a fresh page doc, with one box when `blocks` is given. */
  createPage(pageId: string, blocks: PMJSON[] | null): Promise<void>
  /** For the notebook doc only; page writes go through `appendBox`/`createPage`. */
  save(docId: string, update: Uint8Array): Promise<void>
  audit(entry: AuditEntry): Promise<void>
}
