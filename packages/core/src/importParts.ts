import { decodeImportBlobMeta, type ImportStatus, type LoroDoc } from 'loro-crdt'
import { withHandles } from './handles'

function isShallowSnapshot(bytes: Uint8Array): boolean {
  try {
    return withHandles((h) => {
      const meta = decodeImportBlobMeta(bytes, false)
      h.own(meta.partialStartVersionVector)
      h.own(meta.partialEndVersionVector)
      return meta.mode === 'shallow-snapshot'
    })
  } catch {
    // Not a blob Loro recognises: importBatch reports it as it always has.
    return false
  }
}

/**
 * Imports a doc's stored or received parts. Every loader goes through here, never `importBatch` on
 * its own: Loro 1.17's `importBatch` drops a shallow snapshot that is not alone in the batch whenever
 * two or more commits came before its shallow point, so every later update stays pending and the doc
 * reads empty. A history erased to a shallow snapshot (GDPR-04) is stored as that snapshot first,
 * which therefore goes in through `import`, and the rest in one batch.
 */
export function importParts(doc: LoroDoc, parts: readonly Uint8Array[]): ImportStatus {
  const [first, ...rest] = parts
  if (first === undefined) return { success: new Map(), pending: null }
  if (!isShallowSnapshot(first)) return doc.importBatch([...parts])
  const status = doc.import(first)
  if (rest.length === 0) return status
  const after = doc.importBatch(rest)
  return after.pending === null ? { ...after, pending: status.pending } : after
}
