import { NotebookDoc, PageDoc } from '@slate/core'
import type { DocSource } from '@slate/mcp'
import type { DocStore } from '../store'

/**
 * The one DocSource over the desktop store, for the headless CLI and for the app. `store` is asked
 * for at each call, so the app's source turns into `Locked` errors the moment the notes close.
 * `onSaved` runs after a write committed (the app tells its windows and the search index).
 */
export function storeDocSource(store: () => DocStore, onSaved: (docId: string, update: Uint8Array) => void = () => {}): DocSource {
  return {
    notebooks: async () =>
      store()
        .list('notebook:')
        .map((docId) => ({ id: docId.slice('notebook:'.length), doc: NotebookDoc.fromUpdates(store().load(docId)) })),
    loadPage: async (pageId) => PageDoc.fromUpdates(store().load(`page:${pageId}`)),
    save: async (docId, update) => {
      store().append(docId, update)
      onSaved(docId, update)
    },
    audit: async (entry) => store().appendAudit(entry),
  }
}
