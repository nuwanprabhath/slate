import type { SearchResults, SearchScope } from '../../../../shared/api'
import type { LibraryNotebook } from '../types'

/** What the scope picker remembers: "This notebook" follows whichever notebook is open. */
export type StoredScope = { kind: 'all' } | { kind: 'notebook' } | { kind: 'section'; id: string }

/** The picker's choice as it stands now: a remembered section that no longer exists becomes "This notebook". */
export function effectiveScope(stored: StoredScope | undefined, library: LibraryNotebook[], currentNotebookId: string | null): StoredScope {
  if (stored?.kind === 'notebook') return stored
  if (stored?.kind === 'section') {
    const exists = library.some((nb) => nb.sections.some((s) => s.id === stored.id))
    return exists ? stored : { kind: 'notebook' }
  }
  return { kind: 'all' }
}

export function resolveScope(stored: StoredScope | undefined, library: LibraryNotebook[], currentNotebookId: string | null): SearchScope {
  const scope = effectiveScope(stored, library, currentNotebookId)
  if (scope.kind === 'section') return scope
  if (scope.kind === 'notebook' && currentNotebookId) return { kind: 'notebook', id: currentNotebookId }
  return { kind: 'all' }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function summaryText(results: SearchResults): string {
  if (results.total === 0) return 'No results'
  const text = `${plural(results.total, 'result')} in ${plural(results.pages.length, 'page')}`
  return results.truncated ? `${text} (showing the first ${results.total})` : text
}
