import { decodeImportBlobMeta, LoroDoc, type ImportStatus } from 'loro-crdt'
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
 * A cheap first look, before the decode: a Loro blob is `loro`, a 16-byte checksum, then its mode as a big-endian
 * u16, and snapshots (shallow or not) are mode 3. Decoding every row's header costs about as much as importing
 * the rows, so only a snapshot is decoded. A header this does not recognise is treated as not shallow, which
 * loads exactly as before the scan existed.
 */
function maySnapshot(bytes: Uint8Array): boolean {
  return bytes.length > 21 && bytes[20] === 0 && bytes[21] === 3
}

function shallowFirst(doc: LoroDoc, first: Uint8Array, rest: readonly Uint8Array[]): ImportStatus {
  const status = doc.import(first)
  if (rest.length === 0) return status
  const after = doc.importBatch([...rest])
  return after.pending === null ? { ...after, pending: status.pending } : after
}

/**
 * Imports a doc's stored or received parts. Every loader goes through here, never `importBatch` on
 * its own: Loro 1.17's `importBatch` drops a shallow snapshot that is not alone in the batch whenever
 * two or more commits came before its shallow point, so every later update stays pending and the doc
 * reads empty. A history erased to a shallow snapshot (GDPR-04) is stored as that snapshot first,
 * which therefore goes in through `import`, and the rest in one batch. A v0.7.14 device stored a
 * received shallow snapshot in listing order, where git lists the chunks built on it first: when the
 * batch leaves updates pending, the snapshot goes in first instead.
 */
export function importParts(doc: LoroDoc, parts: readonly Uint8Array[]): ImportStatus {
  const [first, ...rest] = parts
  if (first === undefined) return { success: new Map(), pending: null }
  if (isShallowSnapshot(first)) return shallowFirst(doc, first, rest)
  const at = rest.findIndex((part) => maySnapshot(part) && isShallowSnapshot(part))
  if (at === -1) return doc.importBatch([...parts])
  // A batch that loads cleanly (full history before the snapshot) loads exactly as it always has.
  const trial = new LoroDoc()
  try {
    const status = trial.importBatch([...parts])
    if (status.pending === null || status.pending.size === 0) return doc.importBatch([...parts])
  } finally {
    trial.free()
  }
  return shallowFirst(doc, rest[at]!, parts.filter((_, i) => i !== at + 1))
}
