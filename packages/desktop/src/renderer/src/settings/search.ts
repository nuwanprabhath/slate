export interface Searchable {
  label: string
  blurb: string
  keywords?: string[]
}

/** The sections whose label, blurb or keywords contain the query, ignoring case; all of them for a blank query. */
export function filterSections<T extends Searchable>(sections: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...sections]
  return sections.filter((s) => [s.label, s.blurb, ...(s.keywords ?? [])].some((text) => text.toLowerCase().includes(q)))
}
