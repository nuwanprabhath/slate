import { clipboard, ClipboardItem, ipcMain, nativeImage } from 'electron'
import { CH } from '../shared/ipc'
import type { Settings } from '../shared/api'
import type { BlobStore } from './blobs'
import type { AuthService } from './onenote/auth'
import type { ImportService } from './onenote/importService'
import { readSettings, writeSettings } from './settings'
import type { DocStore } from './store'

export function registerIpc(store: DocStore, blobs: BlobStore): void {
  ipcMain.handle(CH.docsList, (_e, prefix: string) => store.list(prefix))
  ipcMain.handle(CH.docsLoad, (_e, docId: string) => store.load(docId))
  ipcMain.handle(CH.docsAppend, (_e, docId: string, update: Uint8Array) => store.append(docId, update))
  ipcMain.handle(CH.docsRemove, (_e, docId: string) => store.remove(docId))
  ipcMain.handle(CH.blobsPut, (_e, bytes: Uint8Array, mime: string) => blobs.put(bytes, mime))
  ipcMain.handle(CH.blobsCopyImage, async (_e, url: string) => {
    const file = blobs.pathForUrl(url)
    const image = file ? nativeImage.createFromPath(file) : null
    if (!image || image.isEmpty()) return false
    // Electron 45's clipboard is the async W3C-style API; there is no writeImage.
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
    return true
  })
  ipcMain.handle(CH.settingsGet, () => readSettings(store))
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => writeSettings(store, patch))
  ipcMain.handle(CH.auditList, (_e, limit?: number) => store.listAudit(limit ?? 200))
  ipcMain.handle(CH.clipboardText, () => clipboard.readText())
}

export function registerOneNoteIpc(auth: AuthService, importer: ImportService, setClientId: (id: string) => void): void {
  ipcMain.handle(CH.onenoteStatus, () => auth.status())
  ipcMain.handle(CH.onenoteSignIn, () => auth.signIn())
  ipcMain.handle(CH.onenoteSignOut, () => auth.signOut())
  ipcMain.handle(CH.onenoteTree, () => importer.tree())
  ipcMain.handle(CH.onenoteStart, (_e, ids: string[]) => importer.start(ids))
  ipcMain.handle(CH.onenoteRetry, () => importer.retryFailed())
  ipcMain.handle(CH.onenoteCancel, () => importer.cancel())
  ipcMain.handle(CH.onenoteSetClientId, (_e, id: string) => setClientId(id.trim()))
}
