import { BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, type OpenDialogOptions } from 'electron'
import { CH } from '../shared/ipc'
import type { BackupPick, GitAuthMode, GitSettings, Settings, SyncConfig } from '../shared/api'
import { scanBackup } from './onenote/backup'
import type { BlobStore } from './blobs'
import type { AuthService } from './onenote/auth'
import type { ImportService } from './onenote/importService'
import { onSettingsWritten, readSettings, writeSettings } from './settings'
import type { DocStore } from './store'
import type { SyncService } from './sync/syncService'

export function registerIpc(store: DocStore, blobs: BlobStore, onAppend: () => void = () => {}): void {
  ipcMain.handle(CH.docsList, (_e, prefix: string) => store.list(prefix))
  ipcMain.handle(CH.docsLoad, (_e, docId: string) => store.load(docId))
  ipcMain.handle(CH.docsAppend, (_e, docId: string, update: Uint8Array) => {
    store.append(docId, update)
    onAppend()
  })
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
  onSettingsWritten((settings) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.settingsChanged, settings)))
  ipcMain.handle(CH.auditList, (_e, limit?: number) => store.listAudit(limit ?? 200))
  ipcMain.handle(CH.clipboardText, () => clipboard.readText())
}

export function registerSyncIpc(sync: SyncService): void {
  ipcMain.handle(CH.syncStatus, () => sync.status())
  ipcMain.handle(CH.syncSetEnabled, (_e, on: boolean) => sync.setEnabled(on))
  ipcMain.handle(CH.syncConfigure, (_e, config: SyncConfig) => sync.configure(config))
  ipcMain.handle(CH.syncTestGit, (_e, git: GitSettings, token?: string) => sync.testGit(git, token))
  ipcMain.handle(CH.syncGitAuthInfo, () => sync.gitAuthInfo())
  ipcMain.handle(CH.syncCreateRepo, (_e, name: string, auth: GitAuthMode, token?: string) => sync.createRepo(name, auth, token))
  ipcMain.handle(CH.syncDeviceSignIn, () => sync.deviceSignIn())
  ipcMain.handle(CH.syncDeviceSignInWait, () => sync.deviceSignInWait())
  ipcMain.handle(CH.syncNow, () => sync.now())
  ipcMain.handle(CH.syncConflicts, (_e, pageId?: string) => sync.conflicts(pageId))
  ipcMain.handle(CH.syncResolve, (_e, id: string, choice: 'merged' | 'mine' | 'theirs') => sync.resolve(id, choice))
}

/** Asks for backup files or folders. E2E runs set SLATE_E2E_BACKUP_PATH instead of opening a window. */
async function chooseBackupPaths(): Promise<string[] | null> {
  if (process.env.SLATE_E2E === '1' && process.env.SLATE_E2E_BACKUP_PATH) return [process.env.SLATE_E2E_BACKUP_PATH]
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: OpenDialogOptions = {
    title: 'Choose OneNote backup files or folders',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'OneNote sections', extensions: ['one', 'onepkg'] }],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
}

export function registerOneNoteIpc(auth: AuthService, importer: ImportService, setClientId: (id: string) => void): void {
  ipcMain.handle(CH.onenotePickBackup, async (): Promise<BackupPick | null> => {
    const paths = await chooseBackupPaths()
    if (!paths) return null
    return { paths, sections: scanBackup(paths).map(({ id, name, date, notebook }) => ({ id, name, date, notebook })) }
  })
  ipcMain.handle(CH.onenoteStartBackup, (_e, paths: string[], ids: string[]) => importer.startBackup(paths, ids))
  ipcMain.handle(CH.onenoteStatus, () => auth.status())
  ipcMain.handle(CH.onenoteSignIn, () => auth.signIn())
  ipcMain.handle(CH.onenoteSignOut, () => auth.signOut())
  ipcMain.handle(CH.onenoteTree, () => importer.tree())
  ipcMain.handle(CH.onenoteStart, (_e, ids: string[]) => importer.start(ids))
  ipcMain.handle(CH.onenoteRetry, () => importer.retryFailed())
  ipcMain.handle(CH.onenoteCancel, () => importer.cancel())
  ipcMain.handle(CH.onenoteSetClientId, (_e, id: string) => setClientId(id.trim()))
}
