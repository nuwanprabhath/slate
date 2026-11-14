import { compileQuery,hasNestedUnboundedQuantifier, matchAll, NotebookDoc, PageDoc, type PMJSON, type TreeItem } from '@slate/core'
import type { SearchMatch, SearchPageResult, SearchQuery, SearchResults } from '../../shared/api'
import type { DocCursor, DocStore, SearchRow } from '../store'
import { snippetAround } from './snippet'

/** Bump when the rows' shape or text extraction changes: the next start rebuilds the index. */
export const SEARCH_INDEX_VERSION = '1'
const VERSION_KEY = 'search.version'
/** How far the last build got, so a restart carries on instead of starting the whole index again. */
const PROGRESS_KEY = 'search.progress'
export const MAX_MATCHES = 500
const CONTEXT = 40
// FTS5's trigram tokenizer matches no rows for a phrase shorter than this.
const MIN_PHRASE = 3
/** Pages being edited, kept in memory so a re-index imports only their new rows. */
const LIVE_PAGES = 4
/** A build slice yields the thread well inside the 16 ms keystroke budget it shares. */
const SLICE_MS = 8
/** A scan that cannot use the trigram index stops here and says it truncated. */
const SCAN_BUDGET_MS = 250
/** Longest row text handed to a user's regular expression. */
const MAX_REGEX_TEXT = 20_000

interface PageMeta {
  pageTitle: string
  sectionId: string
  sectionName: string
  notebookId: string
  notebookName: string
  /** Position in the notebooks' tree order, so results list pages as the sidebar does. */
  order: number
}

/**
 * Text per block, as the in-page find bar sees it: inline leaves (hard breaks) count as one
 * placeholder character, so a match's occurrence in its box lines up with the find bar's.
 */
function blockTexts(node: PMJSON, out: string[]): void {
  const children = node.content ?? []
  if (children.some((c) => c.type === 'text')) {
    out.push(children.map((c) => (c.type === 'text' ? (c.text ?? '') : '￼')).join(''))
    return
  }
  for (const c of children) blockTexts(c, out)
}

/** Box text per block, in reading order. Private boxes too: the flag only hides boxes from AI. */
export function pageRows(page: PageDoc): SearchRow[] {
  const rows: SearchRow[] = []
  const boxes = page.listBoxes().sort((a, b) => a.y - b.y || a.x - b.x)
  for (const box of boxes) {
    const json = page.boxContent(box.id)
    const texts: string[] = []
    if (json) blockTexts(json, texts)
    for (const text of texts) if (text !== '') rows.push({ boxId: box.id, ord: rows.length, text })
  }
  return rows
}

/**
 * The full-text index behind "Find in Notes". Page edits re-index that page after a quiet spell, off
 * the keystroke path; queries flush pending work first so they never see stale rows.
 */
export class SearchIndex {
  private readonly debounceMs: number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private meta: Map<string, PageMeta> | null = null
  /** Recently edited pages, least recent first, and how far into their rows each has read. */
  private readonly live = new Map<string, { page: PageDoc; cursor: DocCursor }>()

  private readonly sliceMs: number
  private readonly now: () => number
  private readonly scheduleSlice: (run: () => void) => void
  /** Page docs the running build has still to index, or null when no build is running. */
  private pending: string[] | null = null

  constructor(
    private readonly store: DocStore,
    options: { debounceMs?: number; sliceMs?: number; now?: () => number; schedule?: (run: () => void) => void } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 500
    this.sliceMs = options.sliceMs ?? SLICE_MS
    this.now = options.now ?? Date.now
    this.scheduleSlice = options.schedule ?? ((run) => void setImmediate(run))
  }

  /**
   * Builds every page when the index is empty or from another version. True when a build started.
   * The build runs a slice at a time off the keystroke path, carrying on after the thread has had a
   * turn, and a query waits only for the pages it has left.
   */
  ensureBuilt(): boolean {
    const stored = this.store.getSyncMeta(VERSION_KEY)
    const current = stored && new TextDecoder().decode(stored) === SEARCH_INDEX_VERSION
    const pageDocs = this.store.list('page:')
    if (current && (this.store.hasSearchRows() || pageDocs.length === 0)) return false
    const done = this.buildProgress()
    if (done === null) this.store.clearSearch()
    this.pending = done === null ? pageDocs : pageDocs.filter((docId) => docId > done)
    this.buildSlice()
    return true
  }

  /** The last page doc the interrupted build indexed, or null when there is nothing to resume. */
  private buildProgress(): string | null {
    const raw = this.store.getSyncMeta(PROGRESS_KEY)
    if (!raw) return null
    const [version, docId] = new TextDecoder().decode(raw).split('\n')
    return version === SEARCH_INDEX_VERSION && docId ? docId : null
  }

  private buildSlice(untilDone = false): void {
    const pending = this.pending
    if (!pending) return
    const started = this.now()
    while (pending.length > 0 && this.pending === pending) {
      const docId = pending.shift()!
      this.indexPage(docId.slice('page:'.length))
      this.store.setSyncMeta(PROGRESS_KEY, new TextEncoder().encode(`${SEARCH_INDEX_VERSION}\n${docId}`))
      if (!untilDone && this.now() - started >= this.sliceMs) break
    }
    if (this.pending !== pending) return
    if (pending.length > 0) {
      this.scheduleSlice(() => this.buildSlice())
      return
    }
    this.pending = null
    this.store.setSyncMeta(VERSION_KEY, new TextEncoder().encode(SEARCH_INDEX_VERSION))
    this.store.setSyncMeta(PROGRESS_KEY, new TextEncoder().encode(''))
  }

  /** A page or notebook doc changed: re-index it after the debounce. */
  docChanged(docId: string): void {
    if (!docId.startsWith('page:') && !docId.startsWith('notebook:')) return
    clearTimeout(this.timers.get(docId))
    this.timers.set(
      docId,
      setTimeout(() => this.run(docId), this.debounceMs),
    )
  }

  docRemoved(docId: string): void {
    clearTimeout(this.timers.get(docId))
    this.timers.delete(docId)
    this.live.delete(docId)
    if (docId.startsWith('page:')) this.store.removeSearchPage(docId.slice('page:'.length))
    else if (docId.startsWith('notebook:')) this.meta = null
  }

  flush(): void {
    for (const docId of [...this.timers.keys()]) this.run(docId)
  }

  query(q: SearchQuery): SearchResults {
    // A query sees every page, so it finishes whatever the sliced build has left before matching.
    if (this.pending) this.buildSlice(true)
    this.flush()
    // Exponential backtracking would freeze the main thread, the idle lock with it, so it never runs.
    if (q.regex && hasNestedUnboundedQuantifier(q.text)) return { pages: [], total: 0, truncated: true }
    const re = compileQuery(q.text, q)
    if (!re) return { pages: [], total: 0, truncated: false }
    const scope = q.scope.kind === 'all' ? null : { column: q.scope.kind === 'section' ? ('section_id' as const) : ('notebook_id' as const), id: q.scope.id }
    const phrase = !q.regex && [...q.text].length >= MIN_PHRASE ? q.text : null
    const meta = this.pageMeta()
    const byPage = new Map<string, SearchMatch[]>()
    const occurrences = new Map<string, number>()
    let total = 0
    let truncated = false
    // Without a trigram phrase every row is matched here: bound that scan by the clock.
    const budgeted = phrase === null
    const started = this.now()
    for (const row of this.store.searchRows(scope, phrase)) {
      if (!meta.has(row.pageId)) continue
      if (budgeted && this.now() - started >= SCAN_BUDGET_MS) {
        truncated = true
        break
      }
      const text = row.text.length > MAX_REGEX_TEXT ? row.text.slice(0, MAX_REGEX_TEXT) : row.text
      if (text.length < row.text.length) truncated = true
      for (const [from, to] of matchAll(text, re, q.wholeWord)) {
        if (total === MAX_MATCHES) {
          truncated = true
          break
        }
        const key = `${row.pageId}\n${row.boxId}`
        const occurrence = occurrences.get(key) ?? 0
        occurrences.set(key, occurrence + 1)
        const { snippet, range } = snippetAround(text, from, to, CONTEXT)
        const list = byPage.get(row.pageId) ?? []
        list.push({ boxId: row.boxId, snippet, ranges: [range], occurrence })
        byPage.set(row.pageId, list)
        total++
      }
      if (truncated) break
    }
    const pages: SearchPageResult[] = [...byPage]
      .map(([pageId, matches]) => {
        const { order: _order, ...m } = meta.get(pageId)!
        return { pageId, ...m, matches }
      })
      .sort((a, b) => meta.get(a.pageId)!.order - meta.get(b.pageId)!.order)
    return { pages, total, truncated }
  }

  close(): void {
    this.pending = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.live.clear()
  }

  private run(docId: string): void {
    clearTimeout(this.timers.get(docId))
    this.timers.delete(docId)
    if (docId.startsWith('page:')) this.indexLivePage(docId)
    else this.refreshScopes()
  }

  /**
   * An edit's re-index runs on the main thread, which also routes key presses: rebuilding a long
   * page from every stored row there stalled typing, so the page stays in memory and takes only its
   * new rows.
   */
  private indexLivePage(docId: string): void {
    const pageId = docId.slice('page:'.length)
    const known = this.live.get(docId)
    const { parts, cursor, full } = this.store.loadSince(docId, known?.cursor)
    this.live.delete(docId)
    if (full && parts.length === 0) return this.store.removeSearchPage(pageId)
    if (known && !full && parts.length === 0) {
      this.live.set(docId, known)
      return
    }
    const page = full || !known ? PageDoc.fromUpdates(parts) : known.page
    if (!full && known) page.doc.importBatch(parts)
    this.live.set(docId, { page, cursor })
    if (this.live.size > LIVE_PAGES) this.live.delete(this.live.keys().next().value!)
    const m = this.pageMeta().get(pageId)
    this.store.replaceSearchPage({ pageId, sectionId: m?.sectionId ?? '', notebookId: m?.notebookId ?? '' }, pageRows(page))
  }

  private indexPage(pageId: string): void {
    const updates = this.store.load(`page:${pageId}`)
    if (updates.length === 0) return this.store.removeSearchPage(pageId)
    const m = this.pageMeta().get(pageId)
    this.store.replaceSearchPage({ pageId, sectionId: m?.sectionId ?? '', notebookId: m?.notebookId ?? '' }, pageRows(PageDoc.fromUpdates(updates)))
  }

  /** A notebook changed (a page moved, renamed or deleted): re-read the tree and fix the rows' scope. */
  private refreshScopes(): void {
    const old = this.meta
    this.meta = null
    for (const [pageId, m] of this.pageMeta()) {
      const was = old?.get(pageId)
      if (was && was.sectionId === m.sectionId && was.notebookId === m.notebookId) continue
      this.store.setSearchPageScope(pageId, m.sectionId, m.notebookId)
    }
  }

  private pageMeta(): Map<string, PageMeta> {
    if (this.meta) return this.meta
    const meta = new Map<string, PageMeta>()
    for (const docId of this.store.list('notebook:')) {
      const notebookId = docId.slice('notebook:'.length)
      const nb = NotebookDoc.fromUpdates(this.store.load(docId))
      const walk = (items: TreeItem[], section: TreeItem | null) => {
        for (const item of items) {
          if (item.kind === 'page' && item.pageId && section)
            meta.set(item.pageId, { pageTitle: item.title, sectionId: section.id, sectionName: section.title, notebookId, notebookName: nb.name, order: meta.size })
          walk(item.children, item.kind === 'section' ? item : section)
        }
      }
      walk(nb.items(), null)
    }
    this.meta = meta
    return meta
  }
}
