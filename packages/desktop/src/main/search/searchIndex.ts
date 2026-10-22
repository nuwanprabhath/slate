import { compileQuery, contentToJSON, matchAll, NotebookDoc, PageDoc, type PMJSON, type TreeItem } from '@slate/core'
import type { SearchMatch, SearchPageResult, SearchQuery, SearchResults } from '../../shared/api'
import type { DocStore, SearchRow } from '../store'

/** Bump when the rows' shape or text extraction changes: the next start rebuilds the index. */
export const SEARCH_INDEX_VERSION = '1'
const VERSION_KEY = 'search.version'
export const MAX_MATCHES = 500
const CONTEXT = 40
// FTS5's trigram tokenizer matches no rows for a phrase shorter than this.
const MIN_PHRASE = 3

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
    const content = page.contentMap(box.id)
    const json = content ? contentToJSON(content) : null
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

  constructor(private readonly store: DocStore, options: { debounceMs?: number } = {}) {
    this.debounceMs = options.debounceMs ?? 500
  }

  /** Builds every page when the index is empty or from another version. True when it built. */
  ensureBuilt(): boolean {
    const stored = this.store.getSyncMeta(VERSION_KEY)
    const current = stored && new TextDecoder().decode(stored) === SEARCH_INDEX_VERSION
    const pageDocs = this.store.list('page:')
    if (current && (this.store.hasSearchRows() || pageDocs.length === 0)) return false
    this.store.clearSearch()
    for (const docId of pageDocs) this.indexPage(docId.slice('page:'.length))
    this.store.setSyncMeta(VERSION_KEY, new TextEncoder().encode(SEARCH_INDEX_VERSION))
    return true
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
    if (docId.startsWith('page:')) this.store.removeSearchPage(docId.slice('page:'.length))
    else if (docId.startsWith('notebook:')) this.meta = null
  }

  flush(): void {
    for (const docId of [...this.timers.keys()]) this.run(docId)
  }

  query(q: SearchQuery): SearchResults {
    this.flush()
    const re = compileQuery(q.text, q)
    if (!re) return { pages: [], total: 0, truncated: false }
    const scope = q.scope.kind === 'all' ? null : { column: q.scope.kind === 'section' ? ('section_id' as const) : ('notebook_id' as const), id: q.scope.id }
    const phrase = !q.regex && [...q.text].length >= MIN_PHRASE ? q.text : null
    const meta = this.pageMeta()
    const byPage = new Map<string, SearchMatch[]>()
    const occurrences = new Map<string, number>()
    let total = 0
    let truncated = false
    for (const row of this.store.searchRows(scope, phrase)) {
      if (!meta.has(row.pageId)) continue
      for (const [from, to] of matchAll(row.text, re, q.wholeWord)) {
        if (total === MAX_MATCHES) {
          truncated = true
          break
        }
        const key = `${row.pageId}\n${row.boxId}`
        const occurrence = occurrences.get(key) ?? 0
        occurrences.set(key, occurrence + 1)
        const start = Math.max(0, from - CONTEXT)
        const end = Math.min(row.text.length, to + CONTEXT)
        const snippet = row.text.slice(start, end).replace(/[￼\n]/g, ' ')
        const list = byPage.get(row.pageId) ?? []
        list.push({ boxId: row.boxId, snippet, ranges: [[from - start, to - start]], occurrence })
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
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private run(docId: string): void {
    clearTimeout(this.timers.get(docId))
    this.timers.delete(docId)
    if (docId.startsWith('page:')) this.indexPage(docId.slice('page:'.length))
    else this.refreshScopes()
  }

  private indexPage(pageId: string): void {
    const updates = this.store.load(`page:${pageId}`)
    if (updates.length === 0) return this.store.removeSearchPage(pageId)
    const m = this.pageMeta().get(pageId)
    this.store.replaceSearchPage({ pageId, sectionId: m?.sectionId ?? '', notebookId: m?.notebookId ?? '' }, pageRows(PageDoc.fromUpdates(updates)))
  }

  /** A notebook changed (a page moved, renamed or deleted): re-read the tree and fix the rows' scope. */
  private refreshScopes(): void {
    this.meta = null
    for (const [pageId, m] of this.pageMeta()) this.store.setSearchPageScope(pageId, m.sectionId, m.notebookId)
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
