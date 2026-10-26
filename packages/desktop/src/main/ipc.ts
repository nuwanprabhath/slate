import { env } from './testHooks'
import { BrowserWindow, clipboard, ClipboardItem, dialog, nativeImage, type OpenDialogOptions } from 'electron'
import type { IpcRegistrar } from './ipcGuard'
import { openExternalSafe } from './openExternal'
import { CH } from '../shared/ipc'
import type { BackupPick, GitAuthMode, GitSettings, SearchQuery, Settings, SyncConfig } from '../shared/api'
import { configureLogging } from './log/configure'
import { scanBackup } from './onenote/backup'
import { ImageTooLarge, type BlobStore } from './blobs'
import type { AuthService } from './onenote/auth'
import type { ImportService } from './onenote/importService'
import { onSettingsWritten, readSettings, writeSettings } from './settings'
import type { SearchIndex } from './search/searchIndex'
import type { DocStore } from './store'
import type { SyncService } from './sync/syncService'

// Handlers are registered once for the app's life and take services at call time (§6.2), so the
// accessors throw `Locked` while an encrypted vault is locked.

export function registerIpc(ipc: IpcRegistrar, store: () => DocStore, blobs: () => BlobStore, onAppend: (docId: string) => void = () => {}, onRemove: (docId: string) => void = () => {}): void {
  ipc.handle(CH.docsList, (_e, prefix: string) => store().list(prefix))
  ipc.handle(CH.docsLoad, (_e, docId: string) => store().load(docId))
  ipc.handle(CH.docsAppend, (_e, docId: string, update: Uint8Array) => {
    store().append(docId, update)
    onAppend(docId)
  })
  ipc.handle(CH.docsRemove, (_e, docId: string) => {
    store().remove(docId)
    onRemove(docId)
  })
  ipc.handle(CH.blobsPut, (e, bytes: Uint8Array, mime: string) => {
    try {
      return blobs().put(bytes, mime)
    } catch (err) {
      if (err instanceof ImageTooLarge) {
        const win = BrowserWindow.fromWebContents(e.sender)
        const box = { type: 'warning' as const, message: 'This image is too large', detail: err.message }
        void (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box))
      }
      throw err
    }
  })
  ipc.handle(CH.blobsCopyImage, async (_e, url: string) => {
    const found = blobs().readForUrl(url)
    const image = found ? nativeImage.createFromBuffer(Buffer.from(found.bytes)) : null
    if (!image || image.isEmpty()) return false
    // Electron 45's clipboard is the async W3C-style API; there is no writeImage.
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
    return true
  })
  ipc.handle(CH.settingsGet, () => readSettings(store()))
  ipc.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => writeSettings(store(), patch))
  onSettingsWritten((settings) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.settingsChanged, settings)))
  onSettingsWritten((settings) => configureLogging(settings))
  ipc.handle(CH.auditList, (_e, limit?: number) => store().listAudit(limit ?? 200))
  ipc.handle(CH.clipboardText, () => clipboard.readText())
  ipc.handle(CH.openExternal, (_e, url: unknown) => openExternalSafe(url))
}

/** A well-formed SearchQuery from the untrusted renderer: the types, the scope kinds, a bounded text. */
export function isSearchQuery(value: unknown): value is SearchQuery {
  if (typeof value !== 'object' || value === null) return false
  const q = value as Record<string, unknown>
  const scope = q.scope as Record<string, unknown> | null | undefined
  const scoped = typeof scope === 'object' && scope !== null && (scope.kind === 'all' || ((scope.kind === 'notebook' || scope.kind === 'section') && typeof scope.id === 'string'))
  return typeof q.text === 'string' && q.text.length <= 10_000 && typeof q.matchCase === 'boolean' && typeof q.wholeWord === 'boolean' && typeof q.regex === 'boolean' && scoped
}

export function registerSearchIpc(ipc: IpcRegistrar, index: () => SearchIndex): void {
  ipc.handle(CH.searchQuery, (_e, query: unknown) => {
    if (!isSearchQuery(query)) throw new Error('Refused a malformed search query')
    return index().query(query)
  })
}

export function registerSyncIpc(ipc: IpcRegistrar, sync: () => SyncService): void {
  ipc.handle(CH.syncStatus, () => sync().status())
  ipc.handle(CH.syncSetEnabled, (_e, on: boolean) => sync().setEnabled(on))
  ipc.handle(CH.syncConfigure, (_e, config: SyncConfig) => sync().configure(config))
  ipc.handle(CH.syncTestGit, (_e, git: GitSettings, token?: string) => sync().testGit(git, token))
  ipc.handle(CH.syncGitAuthInfo, () => sync().gitAuthInfo())
  ipc.handle(CH.syncCreateRepo, (_e, name: string, auth: GitAuthMode, token?: string) => sync().createRepo(name, auth, token))
  ipc.handle(CH.syncDeviceSignIn, () => sync().deviceSignIn())
  ipc.handle(CH.syncDeviceSignInWait, () => sync().deviceSignInWait())
  ipc.handle(CH.syncNow, () => sync().now())
  ipc.handle(CH.syncConflicts, (_e, pageId?: string) => sync().conflicts(pageId))
  ipc.handle(CH.syncResolve, (_e, id: string, choice: 'merged' | 'mine' | 'theirs') => sync().resolve(id, choice))
  ipc.handle(CH.syncOpened, (_e, notebookId: string) => sync().recordOpen(notebookId))
}

/** Asks for backup files or folders. E2E runs set SLATE_E2E_BACKUP_PATH instead of opening a window. */
async function chooseBackupPaths(): Promise<string[] | null> {
  const e2ePath = env('SLATE_E2E') === '1' ? env('SLATE_E2E_BACKUP_PATH') : undefined
  if (e2ePath) return [e2ePath]
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: OpenDialogOptions = {
    title: 'Choose OneNote backup files or folders',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'OneNote sections', extensions: ['one', 'onepkg'] }],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
}

export function registerOneNoteIpc(ipc: IpcRegistrar, auth: AuthService, importer: () => ImportService, setClientId: (id: string) => void): void {
  ipc.handle(CH.onenotePickBackup, async (): Promise<BackupPick | null> => {
    const paths = await chooseBackupPaths()
    if (!paths) return null
    return { paths, sections: scanBackup(paths).map(({ id, name, date, notebook }) => ({ id, name, date, notebook })) }
  })
  ipc.handle(CH.onenoteStartBackup, (_e, paths: string[], ids: string[]) => importer().startBackup(paths, ids))
  ipc.handle(CH.onenoteStatus, () => auth.status())
  ipc.handle(CH.onenoteSignIn, () => auth.signIn())
  ipc.handle(CH.onenoteSignOut, () => auth.signOut())
  ipc.handle(CH.onenoteTree, () => importer().tree())
  ipc.handle(CH.onenoteStart, (_e, ids: string[]) => importer().start(ids))
  ipc.handle(CH.onenoteRetry, () => importer().retryFailed())
  ipc.handle(CH.onenoteCancel, () => importer().cancel())
  ipc.handle(CH.onenoteSetClientId, (_e, id: string) => setClientId(id.trim()))
}
