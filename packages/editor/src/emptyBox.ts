import type { PMJSON } from '@slate/core'

/** A box holding nothing but one empty paragraph (or no content yet) is litter, as in OneNote. */
export function isEmptyContent(doc: PMJSON | null): boolean {
  const blocks = doc?.content ?? []
  if (blocks.length === 0) return true
  if (blocks.length > 1) return false
  const only = blocks[0]!
  return only.type === 'paragraph' && (only.content ?? []).length === 0
}
