import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { MenuCommand, SlateApi } from '../shared/api'
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
  onMenu(handler) {
    const listener = (_e: IpcRendererEvent, command: MenuCommand) => handler(command)
    ipcRenderer.on(CH.menu, listener)
    return () => ipcRenderer.removeListener(CH.menu, listener)
  },
}

contextBridge.exposeInMainWorld('slate', api)
