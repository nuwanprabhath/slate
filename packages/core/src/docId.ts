// The one definition of what a document id is. Main's IPC validators and sync's remote paths both
// refuse anything else, so a renderer or a remote cannot name a document of its own invention.

// `crypto.randomUUID`, which is all `newId` returns (./ids.ts).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DOC_KINDS: readonly string[] = ['page', 'notebook']

/** An id as `newId` makes it. */
export const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** A document's key in the store: its kind, then an id. */
export function isDocId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const colon = value.indexOf(':')
  return colon > 0 && DOC_KINDS.includes(value.slice(0, colon)) && isId(value.slice(colon + 1))
}
