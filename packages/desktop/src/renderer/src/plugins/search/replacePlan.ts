import type { SearchResults } from '../../../../shared/api'
import type { NotesReplace } from '../../find/notesReplace'

/** A match's key in a preview's tick set. */
export const tickKey = (pageId: string, index: number) => `${pageId}\n${index}`

/** The ticked matches of a preview, as the request that replaces them. */
export function replaceRequest(results: SearchResults, unticked: ReadonlySet<string>, base: Omit<NotesReplace, 'pages'>): NotesReplace {
  return {
    ...base,
    pages: results.pages
      .map((page) => ({ pageId: page.pageId, picks: page.matches.flatMap((m, i) => (unticked.has(tickKey(page.pageId, i)) ? [] : [{ boxId: m.boxId, occurrence: m.occurrence }])) }))
      .filter((page) => page.picks.length > 0),
  }
}

/** "Replace 3 in 2 pages". */
export function confirmText(request: NotesReplace): string {
  const n = request.pages.reduce((sum, p) => sum + p.picks.length, 0)
  return `Replace ${n} in ${request.pages.length} ${request.pages.length === 1 ? 'page' : 'pages'}`
}
