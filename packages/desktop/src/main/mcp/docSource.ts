import { agentBoxes, NotebookDoc, PageDoc, placeBelow, type AgentPage, type PMJSON } from '@slate/core'
import type { DocSource } from '@slate/mcp'
import type { DocCursor, DocStore } from '../store'

/** Decoded docs kept between calls, oldest evicted first. `search` reads every shared page per call. */
const CACHED_PAGES = 64
const CACHED_NOTEBOOKS = 32

interface Cached<T> {
  doc: T
  cursor: DocCursor
}

/** What the source does with a doc it stops caching: a Loro doc's WebAssembly memory is reclaimed only by `free()`. */
type Retire<T> = (doc: T) => void

/** Page docs never leave this file (callers get the `AgentPage` projection), so a dropped one is freed at once. */
const freePage: Retire<PageDoc> = (page) => page.doc.free()

/**
 * `notebooks()` hands the doc itself to the caller, who reads it after this call returns and possibly
 * after a concurrent call evicted it; freeing it then would turn that read into `RuntimeError:
 * unreachable`. So an evicted notebook is left to its holder and only `close()` frees what is cached.
 */
const keepNotebook: Retire<NotebookDoc> = () => {}

/**
 * The one DocSource over the desktop store, for the headless CLI and for the app. `store` is asked
 * for at each call, so the app's source turns into `Locked` errors the moment the notes close.
 * `onSaved` runs after a write committed (the app tells its windows and the search index).
 *
 * Decoded docs and the redacted projections stay in memory between calls, taking only the rows
 * `DocStore.loadSince` has not handed over yet (the pattern `SearchIndex` uses): rebuilding every
 * page per `search` ran on the thread that routes key presses. A different store instance (a relock
 * and unlock) drops everything, since its cursors mean nothing here.
 */
export function storeDocSource(
  store: () => DocStore,
  onSaved: (docId: string, update: Uint8Array) => void = () => {},
): DocSource & { close(): void } {
  const pages = new Map<string, Cached<PageDoc>>()
  const notebooks = new Map<string, Cached<NotebookDoc>>()
  const views = new Map<string, AgentPage>()
  let opened: DocStore | null = null

  function db(): DocStore {
    const current = store()
    if (current !== opened) {
      opened = current
      drop(pages, freePage)
      drop(notebooks, keepNotebook)
      views.clear()
    }
    return current
  }

  function drop<T>(map: Map<string, Cached<T>>, retire: Retire<T>): void {
    for (const { doc } of map.values()) retire(doc)
    map.clear()
  }

  function cached<T>(
    map: Map<string, Cached<T>>,
    limit: number,
    retire: Retire<T>,
    docId: string,
    make: (parts: Uint8Array[]) => T,
    merge: (doc: T, parts: Uint8Array[]) => void,
  ): { doc: T; changed: boolean } {
    // The store first: a different store empties the maps, and its cursors must never meet this map's docs.
    const current = db()
    const known = map.get(docId)
    const { parts, cursor, full } = current.loadSince(docId, known?.cursor)
    map.delete(docId)
    const reuse = known !== undefined && !full
    const doc = reuse ? known.doc : make(parts)
    if (known !== undefined && !reuse) retire(known.doc)
    if (reuse && parts.length > 0) merge(doc, parts)
    map.set(docId, { doc, cursor })
    for (const [oldest, entry] of map) {
      if (map.size <= limit) break
      map.delete(oldest)
      views.delete(oldest)
      retire(entry.doc)
    }
    return { doc, changed: !reuse || parts.length > 0 }
  }

  const cachedPage = (docId: string) => cached(pages, CACHED_PAGES, freePage, docId, PageDoc.fromUpdates, (p, parts) => p.doc.importBatch(parts))
  const cachedNotebook = (docId: string) => cached(notebooks, CACHED_NOTEBOOKS, keepNotebook, docId, NotebookDoc.fromUpdates, (n, parts) => n.doc.importBatch(parts))

  const save = (docId: string, update: Uint8Array) => {
    views.delete(docId)
    db().append(docId, update)
    onSaved(docId, update)
  }

  return {
    notebooks: async () =>
      db()
        .list('notebook:')
        .map((docId) => ({ id: docId.slice('notebook:'.length), doc: cachedNotebook(docId).doc })),
    readPage: async (pageId) => {
      const docId = `page:${pageId}`
      const { doc, changed } = cachedPage(docId)
      const known = views.get(docId)
      if (known && !changed) return known
      const view: AgentPage = { boxes: agentBoxes(doc) }
      views.set(docId, view)
      return view
    },
    appendBox: async (pageId, blocks: PMJSON[]) => {
      const docId = `page:${pageId}`
      const { doc } = cachedPage(docId)
      const from = doc.doc.oplogVersion()
      const { x, y } = placeBelow(doc)
      const boxId = doc.addBox({ x, y, width: 480, content: blocks })
      save(docId, doc.doc.export({ mode: 'update', from }))
      return { boxId }
    },
    createPage: async (pageId, blocks) => {
      const page = new PageDoc()
      if (blocks) page.addBox({ x: 40, y: 40, width: 480, content: blocks })
      save(`page:${pageId}`, page.doc.export({ mode: 'snapshot' }))
    },
    save: async (docId, update) => save(docId, update),
    audit: async (entry) => db().appendAudit(entry),
    /** The source's life is over: frees every cached doc, notebooks included, since no call is left to hold one. */
    close: () => {
      drop(pages, freePage)
      drop(notebooks, (nb) => nb.doc.free())
      views.clear()
      opened = null
    },
  }
}
