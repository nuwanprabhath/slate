import type { SearchResults } from '../../../../shared/api'
import type { NotesReplace, NotesReplaceResult } from '../../find/notesReplace'

/** A match's key in a preview's tick set. */
export const tickKey = (pageId: string, index: number) => `${pageId}\n${index}`

/** The ticked matches of a preview, as the request that replaces them. */
export function replaceRequest(results: SearchResults, unticked: ReadonlySet<string>, base: Omit<NotesReplace, 'pages'>): NotesReplace {
  return {
    ...base,
    pages: results.pages
      .map((page) => ({ pageId: page.pageId, picks: page.matches.flatMap((m, i) => (unticked.has(tickKey(page.pageId, i)) ? [] : [{ boxId: m.boxId, occurrence: m.occurrence, matched: m.snippet.slice(m.ranges[0]?.[0] ?? 0, m.ranges[0]?.[1] ?? 0) }])) }))
      .filter((page) => page.picks.length > 0),
  }
}

/** "Replace 3 in 2 pages". */
export function confirmText(request: NotesReplace): string {
  const n = request.pages.reduce((sum, p) => sum + p.picks.length, 0)
  return `Replace ${n} in ${request.pages.length} ${request.pages.length === 1 ? 'page' : 'pages'}`
}

/**
 * Whether a fresh search lists the same matches for every page the preview listed. Ticks are by
 * position, so if a match moved (one added before an unticked one), confirming would replace the
 * wrong one: the preview must be reviewed again.
 */
export function sameMatches(preview: SearchResults, fresh: SearchResults): boolean {
  const now = new Map(fresh.pages.map((p) => [p.pageId, p.matches]))
  return preview.pages.every((p) => JSON.stringify(now.get(p.pageId)) === JSON.stringify(p.matches))
}

/** What a replace left alone, or null when it did everything it was asked. */
export function replaceNotice(r: NotesReplaceResult): string | null {
  if (r.skipped === 0 && r.failed === 0) return null
  const parts = [`Replaced ${String(r.replaced)} in ${String(r.pages)} ${r.pages === 1 ? 'page' : 'pages'}.`]
  if (r.skipped > 0) parts.push(r.skipped === 1 ? '1 match had changed and was left as it was.' : `${String(r.skipped)} matches had changed and were left as they were.`)
  if (r.failed > 0) parts.push(r.failed === 1 ? '1 page could not be changed.' : `${String(r.failed)} pages could not be changed.`)
  return parts.join(' ')
}
