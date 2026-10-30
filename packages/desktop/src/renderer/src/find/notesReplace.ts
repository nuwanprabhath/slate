import { PageDoc } from '@slate/core'
import { PageSession, pageDocId, type DocPersistence, type FindOptions } from '@slate/editor'

/** A Find in Notes replace: the ticked matches, by page, box and the match's index within its box. */
export interface NotesReplace {
  query: string
  opts: FindOptions
  replacement: string
  preserveCase: boolean
  pages: Array<{ pageId: string; picks: Array<{ boxId: string; occurrence: number }> }>
}

export interface NotesReplaceDeps {
  persistence: DocPersistence
  /** The page on screen: it takes the change through its own session, so its editors redraw. */
  onScreen: () => PageSession | null
}

/**
 * Sessions a replace opened on pages that were not on screen. Their replace is an undo step only
 * that session knows, so the page, when opened, gets this session back instead of a fresh one.
 * Renderer memory only: locking closes this window, and with it these.
 */
const held = new Map<string, PageSession>()

/** The session for a page about to show: one a replace kept (caught up with the store), else a fresh one. */
export async function openPageSession(pageId: string, persistence: DocPersistence): Promise<PageSession> {
  const kept = held.get(pageId)
  if (!kept) return PageSession.open(pageId, persistence)
  held.delete(pageId)
  // Sync or an agent may have written since. Only the new changes go in, as one update: importing
  // the stored snapshot into a doc that already has state clears its UndoManager, the replace's step with it.
  const stored = PageDoc.fromUpdates(await persistence.load(pageDocId(pageId)))
  kept.importExternal([stored.doc.export({ mode: 'update', from: kept.doc.oplogVersion() })])
  return kept
}

/**
 * Replaces the ticked matches page by page, each page one undo step. Every page, on screen or not,
 * goes through `PageSession.replace`, so stored pages change through the same Loro edit (and the
 * same locked-gated docs channels) as typing does.
 */
export async function replaceInNotes(request: NotesReplace, deps: NotesReplaceDeps): Promise<{ replaced: number; pages: number }> {
  let replaced = 0
  let pages = 0
  for (const { pageId, picks } of request.pages) {
    if (picks.length === 0) continue
    const wanted = new Set(picks.map((p) => `${p.boxId}\n${p.occurrence}`))
    const choice = { preserveCase: request.preserveCase, only: (boxId: string, occurrence: number) => wanted.has(`${boxId}\n${occurrence}`) }
    const screen = deps.onScreen()
    let count: number
    if (screen?.pageId === pageId) count = screen.replace(request.query, request.opts, request.replacement, choice)
    else {
      const session = await openPageSession(pageId, deps.persistence)
      count = session.replace(request.query, request.opts, request.replacement, choice)
      if (count > 0 || session.undoManager.canUndo()) held.set(pageId, session)
      else session.close()
    }
    replaced += count
    if (count > 0) pages++
  }
  return { replaced, pages }
}
