import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt'
import { PageDoc, writeContent } from '@slate/core'
import type { ConflictRecord, LocalStore } from '../src/types'

export type MemoryLocal = LocalStore & {
  docs: Map<string, Uint8Array[]>
  blobs: Map<string, Uint8Array>
  conflicts: ConflictRecord[]
  notes: string[]
  appendLocal(docId: string, update: Uint8Array): void
  doc(docId: string): LoroDoc
}

/** A LocalStore in memory: each doc is its list of updates, as in the desktop's SQLite. */
export function memoryLocal(): MemoryLocal {
  const docs = new Map<string, Uint8Array[]>()
  const meta = new Map<string, string>()
  const bytesMeta = new Map<string, Uint8Array>()
  const seen = new Set<string>()
  const blobs = new Map<string, Uint8Array>()
  const synced = new Set<string>()
  const append = (docId: string, update: Uint8Array) => {
    const list = docs.get(docId) ?? []
    list.push(update.slice())
    docs.set(docId, list)
  }

  return {
    docs,
    blobs,
    conflicts: [],
    notes: [],
    appendLocal: append,
    doc(docId) {
      const doc = new LoroDoc()
      const updates = docs.get(docId) ?? []
      if (updates.length > 0) doc.importBatch(updates)
      return doc
    },
    async docIds() {
      return [...docs.keys()]
    },
    async loadDoc(docId) {
      return [...(docs.get(docId) ?? [])]
    },
    async appendRemote(docId, update) {
      append(docId, update)
    },
    async getMeta(key) {
      return meta.get(key)
    },
    async setMeta(key, value) {
      meta.set(key, value)
    },
    async getBytesMeta(key) {
      return bytesMeta.get(key)?.slice()
    },
    async setBytesMeta(key, value) {
      bytesMeta.set(key, value.slice())
    },
    async seen(itemId, eTag) {
      return seen.has(`${itemId}\n${eTag}`)
    },
    async markSeen(itemId, eTag) {
      seen.add(`${itemId}\n${eTag}`)
    },
    async blobNames() {
      return [...blobs.keys()]
    },
    async readBlob(name) {
      const bytes = blobs.get(name)
      if (!bytes) throw new Error(`no blob ${name}`)
      return bytes
    },
    async blobSynced(name) {
      return synced.has(name)
    },
    async markBlobSynced(name) {
      synced.add(name)
    },
    async addConflict(c) {
      this.conflicts.push(c)
    },
    async notify(message) {
      this.notes.push(message)
    }
  }
}

/**
 * Edits a page as one session would: load, mutate, store the new ops as a local update. The
 * optional peer keeps seeded runs reproducible (Loro orders concurrent inserts by peer id).
 */
export function editPage<T>(local: MemoryLocal, docId: string, fn: (page: PageDoc) => T, peer?: bigint): T {
  const doc = local.doc(docId)
  if (peer !== undefined) doc.setPeerId(peer)
  const before = doc.oplogVersion()
  const result = fn(new PageDoc(doc))
  doc.commit()
  const update = doc.export({ mode: 'update', from: before })
  if (doc.oplogVersion().compare(before) !== 0) local.appendLocal(docId, update)
  return result
}

export function addTextBox(page: PageDoc, text: string, at = { x: 0, y: 0 }): string {
  const id = page.addBox({ ...at, width: 200 })
  writeContent(page.contentMap(id)!, [{ type: 'paragraph', content: [{ type: 'text', text }] }])
  page.doc.commit()
  return id
}

/** The first paragraph's text container of a box written by `addTextBox`. */
function firstText(page: PageDoc, boxId: string): LoroText | undefined {
  const children = page.contentMap(boxId)?.get('children')
  const para = children instanceof LoroList ? children.get(0) : undefined
  const inner = para instanceof LoroMap ? para.get('children') : undefined
  const text = inner instanceof LoroList ? inner.get(0) : undefined
  return text instanceof LoroText ? text : undefined
}

export function appendText(page: PageDoc, boxId: string, text: string): void {
  const t = firstText(page, boxId)
  if (!t) return
  t.insert(t.length, text)
  page.doc.commit()
}

export function boxText(page: PageDoc, boxId: string): string | undefined {
  return firstText(page, boxId)?.toString()
}
