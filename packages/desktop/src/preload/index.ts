import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ExternalBatch, MenuCommand, SlateApi } from '../shared/api'
import type { ImportProgress } from '@slate/importer'
import { CH } from '../shared/ipc'

const api: SlateApi = {
  isE2E: process.env.SLATE_E2E === '1',
  docs: {
    list: (prefix) => ipcRenderer.invoke(CH.docsList, prefix),
    load: (docId) => ipcRenderer.invoke(CH.docsLoad, docId),
    append: (docId, update) => ipcRenderer.invoke(CH.docsAppend, docId, update),
    remove: (docId) => ipcRenderer.invoke(CH.docsRemove, docId),
  },
  blobs: {
    put: (bytes, mime) => ipcRenderer.invoke(CH.blobsPut, bytes, mime),
    copyImage: (url) => ipcRenderer.invoke(CH.blobsCopyImage, url),
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch) => ipcRenderer.invoke(CH.settingsSet, patch),
  },
  audit: { list: (limit) => ipcRenderer.invoke(CH.auditList, limit) },
  clipboardText: () => ipcRenderer.invoke(CH.clipboardText),
  onenote: {
    status: () => ipcRenderer.invoke(CH.onenoteStatus),
    signIn: () => ipcRenderer.invoke(CH.onenoteSignIn),
    signOut: () => ipcRenderer.invoke(CH.onenoteSignOut),
    tree: () => ipcRenderer.invoke(CH.onenoteTree),
    start: (ids) => ipcRenderer.invoke(CH.onenoteStart, ids),
    retryFailed: () => ipcRenderer.invoke(CH.onenoteRetry),
    cancel: () => ipcRenderer.invoke(CH.onenoteCancel),
    onProgress(handler) {
      const listener = (_e: IpcRendererEvent, p: ImportProgress) => handler(p)
      ipcRenderer.on(CH.onenoteProgress, listener)
      return () => ipcRenderer.removeListener(CH.onenoteProgress, listener)
    },
    setClientId: (id) => ipcRenderer.invoke(CH.onenoteSetClientId, id),
  },
  onMenu(handler) {
    const listener = (_e: IpcRendererEvent, command: MenuCommand) => handler(command)
    ipcRenderer.on(CH.menu, listener)
    return () => ipcRenderer.removeListener(CH.menu, listener)
  },
  onExternalUpdates(handler) {
    const listener = (_e: IpcRendererEvent, batches: ExternalBatch[]) => handler(batches)
    ipcRenderer.on(CH.externalUpdates, listener)
    return () => ipcRenderer.removeListener(CH.externalUpdates, listener)
  },
}

contextBridge.exposeInMainWorld('slate', api)
