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

/**
 * The same device seen by another remote: what was pushed to, seen on or uploaded to one remote
 * says nothing about the next, so switching remotes pushes everything there once.
 */
export function scopedLocal(local: LocalStore, prefix: string): LocalStore {
  return {
    ...local,
    getMeta: (key) => local.getMeta(prefix + key),
    setMeta: (key, value) => local.setMeta(prefix + key, value),
    getBytesMeta: (key) => local.getBytesMeta(prefix + key),
    setBytesMeta: (key, value) => local.setBytesMeta(prefix + key, value),
    seen: (itemId, eTag) => local.seen(prefix + itemId, eTag),
    markSeen: (itemId, eTag) => local.markSeen(prefix + itemId, eTag),
    blobSynced: async (name) => (await local.getMeta(`${prefix}blob:${name}`)) === '1',
    markBlobSynced: (name) => local.setMeta(`${prefix}blob:${name}`, '1'),
  }
}
