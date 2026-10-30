import { PageDoc, planReplace } from '@slate/core'
import { snippetText } from '../../../shared/snippetText'
import { PageSession, pageDocId, type DocPersistence, type FindOptions } from '@slate/editor'

/** A Find in Notes replace: the ticked matches, by page, box, the match's index within its box and its text. */
export interface NotesReplace {
  query: string
  opts: FindOptions
  replacement: string
  preserveCase: boolean
  pages: Array<{ pageId: string; picks: Array<{ boxId: string; occurrence: number; matched: string }> }>
}

export interface NotesReplaceResult {
  replaced: number
  /** Pages changed. */
  pages: number
  /** Ticked matches left alone: their page is gone or their text no longer matches. */
  skipped: number
  /** Pages whose replace failed; each is left as it was. */
  failed: number
}

export interface NotesReplaceDeps {
  persistence: DocPersistence
  /** Whether the page is still in a notebook; a page deleted since the search is not written to. */
  exists: (pageId: string) => boolean
}

/** How many pages' replaces stay undoable while those pages are closed. */
export const KEPT_PAGES = 20

/**
 * Every page session in this window, one per page, shared by the page view and Find in Notes'
 * replace, so two sessions never edit one page apart (each would replace the same text: "dogdog").
 * `users` counts page views showing it and replaces using it; `kept` marks one held only for the
 * undo step a replace left while the page was closed. Renderer memory only: locking closes the
 * window, and with it these.
 */
interface Entry {
  session: Promise<PageSession>
  users: number
  kept: boolean
}
const entries = new Map<string, Entry>()
/** Kept pages, least recently replaced first. */
const keptOrder = new Set<string>()

function acquire(pageId: string, persistence: DocPersistence): { entry: Entry; existed: boolean } {
  const found = entries.get(pageId)
  if (found) {
    found.users++
    return { entry: found, existed: true }
  }
  const entry: Entry = { session: PageSession.open(pageId, persistence), users: 1, kept: false }
  entries.set(pageId, entry)
  return { entry, existed: false }
}

function closeIfUnused(pageId: string, entry: Entry): void {
  if (entry.users > 0 || entry.kept || entries.get(pageId) !== entry) return
  entries.delete(pageId)
  void entry.session.then((s) => s.close())
}

function unkeep(pageId: string, entry: Entry): void {
  entry.kept = false
  keptOrder.delete(pageId)
}

function keep(pageId: string, entry: Entry): void {
  entry.kept = true
  keptOrder.delete(pageId)
  keptOrder.add(pageId)
  while (keptOrder.size > KEPT_PAGES) {
    const oldest = keptOrder.values().next().value!
    const e = entries.get(oldest)
    keptOrder.delete(oldest)
    if (e) {
      e.kept = false
      closeIfUnused(oldest, e)
    }
  }
}

/**
 * Sync or an agent may have written while the session sat unused. Only the new changes go in, as one
 * update: importing the stored snapshot into a doc that already has state clears its UndoManager.
 */
async function catchUp(session: PageSession, persistence: DocPersistence): Promise<void> {
  const stored = PageDoc.fromUpdates(await persistence.load(pageDocId(session.pageId)))
  session.importExternal([stored.doc.export({ mode: 'update', from: session.doc.oplogVersion() })])
}

/** The session for a page about to show: the page's shared one (caught up if a replace kept it), else a fresh one. */
export async function openPageSession(pageId: string, persistence: DocPersistence): Promise<PageSession> {
  const { entry, existed } = acquire(pageId, persistence)
  const wasKept = entry.kept
  // The view owns the page's undo from here, as for any page it shows.
  unkeep(pageId, entry)
  const session = await entry.session
  if (existed && wasKept) await catchUp(session, persistence)
  return session
}

/** The page view is done with the session. */
export function closePageSession(session: PageSession): void {
  const entry = entries.get(session.pageId)
  if (!entry) return session.close()
  entry.users--
  closeIfUnused(session.pageId, entry)
}

/** Pages were deleted: their kept undo steps go, and nothing writes to them again. */
export function dropPageSessions(pageIds: string[]): void {
  for (const pageId of pageIds) {
    const entry = entries.get(pageId)
    if (!entry) continue
    unkeep(pageId, entry)
    closeIfUnused(pageId, entry)
  }
}

/**
 * Replaces the ticked matches page by page, each page one undo step, all or nothing per page. Every
 * page, on screen or not, goes through `PageSession.replace`, so stored pages change through the
 * same Loro edit (and the same locked-gated docs channels) as typing does. Matches are numbered as
 * the search index numbers them, and a pick whose text no longer matches is skipped.
 */
export async function replaceInNotes(request: NotesReplace, deps: NotesReplaceDeps): Promise<NotesReplaceResult> {
  const result: NotesReplaceResult = { replaced: 0, pages: 0, skipped: 0, failed: 0 }
  for (const { pageId, picks } of request.pages) {
    if (picks.length === 0) continue
    if (!deps.exists(pageId)) {
      result.skipped += picks.length
      continue
    }
    const wanted = new Map(picks.map((p) => [`${p.boxId}\n${p.occurrence}`, p.matched]))
    const { entry, existed } = acquire(pageId, deps.persistence)
    try {
      const session = await entry.session
      if (existed && entry.users === 1) await catchUp(session, deps.persistence)
      // Nothing stored: the page was deleted since the search. An edit would write an orphan doc.
      if (session.doc.frontiers().length === 0) {
        result.skipped += picks.length
        continue
      }
      let count = 0
      try {
        count = session.replace(request.query, request.opts, request.replacement, {
          preserveCase: request.preserveCase,
          numbering: 'search-index',
          only: (boxId, occurrence, matched) => wanted.get(`${boxId}\n${occurrence}`) === snippetText(matched),
        })
      } catch {
        result.failed++
        continue
      }
      result.replaced += count
      result.skipped += picks.length - count
      if (count > 0) {
        result.pages++
        // On screen (another user), the view holds the undo step; otherwise keep the session for it.
        if (entry.users === 1) keep(pageId, entry)
      }
    } finally {
      entry.users--
      closeIfUnused(pageId, entry)
    }
  }
  return result
}

/** The key of a pick in `previewInNotes`' answer. */
export const previewKey = (pageId: string, boxId: string, occurrence: number): string => `${pageId}\n${boxId}\n${String(occurrence)}`

/**
 * What each ticked match would become, worked out on its whole block (a regex's lookbehind, anchors
 * and groups can need more than a result's snippet), from the stored pages, without writing.
 * `loaded` holds pages already read, so a caller can reuse them across calls.
 */
export async function previewInNotes(request: NotesReplace, persistence: DocPersistence, loaded = new Map<string, Promise<PageDoc>>()): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const { pageId, picks } of request.pages) {
    const wanted = new Set(picks.map((p) => `${p.boxId}\n${String(p.occurrence)}`))
    let doc = loaded.get(pageId)
    if (!doc) {
      doc = persistence.load(pageDocId(pageId)).then((updates) => PageDoc.fromUpdates(updates))
      loaded.set(pageId, doc)
    }
    const page = await doc
    const edits = planReplace(page, request.query, request.opts, request.replacement, {
      preserveCase: request.preserveCase,
      only: (boxId, occurrence) => wanted.has(`${boxId}\n${String(occurrence)}`),
    })
    for (const e of edits) out.set(previewKey(pageId, e.boxId, e.occurrence), e.with)
  }
  return out
}

/**
 * `previewInNotes` for a preview that is being typed into: pages are read once per set of results
 * (query, options and picks), not on every keystroke in the replace field. New results, as after a
 * replace or a fresh search, read them again.
 */
export function previewer(persistence: DocPersistence): (request: NotesReplace) => Promise<Map<string, string>> {
  let resultsKey = ''
  let loaded = new Map<string, Promise<PageDoc>>()
  return (request) => {
    const key = JSON.stringify([request.query, request.opts, request.pages])
    if (key !== resultsKey) {
      resultsKey = key
      loaded = new Map()
    }
    return previewInNotes(request, persistence, loaded)
  }
}
