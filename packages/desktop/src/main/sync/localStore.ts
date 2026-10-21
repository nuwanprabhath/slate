import type { LocalStore } from '@slate/sync'
import type { BlobStore } from '../blobs'
import type { DocStore } from '../store'

/**
 * The sync engine's view of this device. `store` must be a connection of its own: rows it appends
 * are then "another connection's commit" to the app, and the external-update watcher delivers
 * them to the open window.
 */
export function docStoreLocal(store: DocStore, blobs: BlobStore, notify: (message: string) => void): LocalStore {
  const text = new TextDecoder()
  return {
    docIds: async () => store.list(''),
    loadDoc: async (docId) => store.load(docId),
    appendRemote: async (docId, update) => store.append(docId, update, 'remote'),
    getMeta: async (key) => {
      const bytes = store.getSyncMeta(key)
      return bytes ? text.decode(bytes) : undefined
    },
    setMeta: async (key, value) => store.setSyncMeta(key, new TextEncoder().encode(value)),
    getBytesMeta: async (key) => store.getSyncMeta(key),
    setBytesMeta: async (key, value) => store.setSyncMeta(key, value),
    seen: async (itemId, eTag) => store.syncSeen(itemId, eTag),
    markSeen: async (itemId, eTag) => store.markSyncSeen(itemId, eTag),
    blobNames: async () => blobs.list(),
    readBlob: async (name) => blobs.read(name),
    blobSynced: async (name) => store.blobSynced(name),
    markBlobSynced: async (name) => store.markBlobSynced(name),
    addConflict: async (c) => store.addConflict(c),
    notify: async (message) => {
      store.addNotice(message)
      notify(message)
    },
  }
}
