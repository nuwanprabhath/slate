import { env } from './testHooks'
import { BrowserWindow, clipboard, dialog, type OpenDialogOptions } from 'electron'
import type { IpcRegistrar } from './ipcGuard'
import { openExternalSafe } from './openExternal'
import { CH } from '../shared/ipc'
import type { BackupPick, SearchQuery } from '../shared/api'
import { GIT_AUTH_MODES, IMAGE_MIMES, isAnyBytes, isBool, isBytes, isCount, isDocId, isDocPrefix, isGitSettings, isId, isOneOf, isSettingsPatch, isSyncConfig, isText, isTextList, MAX_PATH, MAX_UPDATE_BYTES, optional, refuse, RESOLVE_CHOICES } from '../shared/ipcValidators'
import { configureLogging } from './log/configure'
import { scanBackup } from './onenote/backup'
import { ImageTooLarge, type BlobStore } from './blobs'
import type { AuthService } from './onenote/auth'
import type { ImportService } from './onenote/importService'
import { onSettingsWritten, readSettings, writeSettings } from './settings'
import type { SearchIndex } from './search/searchIndex'
import type { DocStore } from './store'
import type { SyncService } from './sync/syncService'

/** An Azure client id, a branch, a repository name, a conflict's key: a short identifier, not free text. */
const MAX_NAME = 200
const MAX_TOKEN = 500
const isName = (v: unknown): v is string => isText(v, MAX_NAME)
const isToken = (v: unknown): v is string => isText(v, MAX_TOKEN)
/** The most files or folders one import may name; the picker returns what the person chose. */
const MAX_PICKED = 1000
/** A OneNote section or notebook id comes from Microsoft Graph, so it is longer than one of Slate's. */
const MAX_EXTERNAL_ID = 500

// Handlers are registered once for the app's life and take services at call time (§6.2), so the
// accessors throw `Locked` while an encrypted vault is locked.

export function registerIpc(ipc: IpcRegistrar, store: () => DocStore, blobs: () => BlobStore, onAppend: (docId: string) => void = () => {}, onRemove: (docId: string) => void = () => {}): void {
  ipc.handle(CH.docsList, (_e, prefix: unknown) => {
    if (!isDocPrefix(prefix)) refuse(CH.docsList)
    return store().list(prefix)
  })
  ipc.handle(CH.docsLoad, (_e, docId: unknown) => {
    if (!isDocId(docId)) refuse(CH.docsLoad)
    return store().load(docId)
  })
  ipc.handle(CH.docsAppend, (_e, docId: unknown, update: unknown) => {
    if (!isDocId(docId) || !isBytes(update, MAX_UPDATE_BYTES)) refuse(CH.docsAppend)
    store().append(docId, update)
    onAppend(docId)
  })
  ipc.handle(CH.docsRemove, (_e, docId: unknown) => {
    if (!isDocId(docId)) refuse(CH.docsRemove)
    store().remove(docId)
    onRemove(docId)
  })
  // The byte cap stays in `BlobStore.put`, whose ImageTooLarge tells the person how big their image was.
  ipc.handle(CH.blobsPut, (e, bytes: unknown, mime: unknown) => {
    if (!isAnyBytes(bytes) || !isOneOf(IMAGE_MIMES, mime)) refuse(CH.blobsPut)
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
  ipc.handle(CH.settingsGet, () => readSettings(store()))
  ipc.handle(CH.settingsSet, (_e, patch: unknown) => {
    // `sanitizePatch` decides every field; the shape is all this channel checks.
    if (!isSettingsPatch(patch)) refuse(CH.settingsSet)
    return writeSettings(store(), patch)
  })
  onSettingsWritten((settings) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.settingsChanged, settings)))
  onSettingsWritten((settings) => configureLogging(settings))
  ipc.handle(CH.auditList, (_e, limit: unknown) => {
    if (!optional(limit, isCount)) refuse(CH.auditList)
    return store().listAudit(limit ?? 200)
  })
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
    if (!isSearchQuery(query)) refuse(CH.searchQuery)
    return index().query(query)
  })
}

export function registerSyncIpc(ipc: IpcRegistrar, sync: () => SyncService): void {
  ipc.handle(CH.syncStatus, () => sync().status())
  ipc.handle(CH.syncSetEnabled, (_e, on: unknown) => {
    if (!isBool(on)) refuse(CH.syncSetEnabled)
    return sync().setEnabled(on)
  })
  ipc.handle(CH.syncConfigure, (_e, config: unknown) => {
    if (!isSyncConfig(config)) refuse(CH.syncConfigure)
    return sync().configure(config)
  })
  ipc.handle(CH.syncTestGit, (_e, git: unknown, token: unknown) => {
    if (!isGitSettings(git) || !optional(token, isToken)) refuse(CH.syncTestGit)
    return sync().testGit(git, token)
  })
  ipc.handle(CH.syncGitAuthInfo, () => sync().gitAuthInfo())
  ipc.handle(CH.syncCreateRepo, (_e, name: unknown, auth: unknown, token: unknown) => {
    if (!isName(name) || !isOneOf(GIT_AUTH_MODES, auth) || !optional(token, isToken)) refuse(CH.syncCreateRepo)
    return sync().createRepo(name, auth, token)
  })
  ipc.handle(CH.syncDeviceSignIn, () => sync().deviceSignIn())
  ipc.handle(CH.syncDeviceSignInWait, () => sync().deviceSignInWait())
  ipc.handle(CH.syncNow, () => sync().now())
  // The renderer asks per page, as `page:<id>`: the key a conflict is recorded under.
  ipc.handle(CH.syncConflicts, (_e, pageId: unknown) => {
    if (!optional(pageId, isDocId)) refuse(CH.syncConflicts)
    return sync().conflicts(pageId)
  })
  ipc.handle(CH.syncResolve, (_e, id: unknown, choice: unknown) => {
    if (!isName(id) || !isOneOf(RESOLVE_CHOICES, choice)) refuse(CH.syncResolve)
    return sync().resolve(id, choice)
  })
  ipc.handle(CH.syncOpened, (_e, notebookId: unknown) => {
    if (!isId(notebookId)) refuse(CH.syncOpened)
    return sync().recordOpen(notebookId)
  })
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
  // F7 residual: the paths come back from the renderer, so main re-checks their shape; which folders
  // the person picked is still the renderer's word (noted for a later wave).
  ipc.handle(CH.onenoteStartBackup, (_e, paths: unknown, ids: unknown) => {
    if (!isTextList(paths, MAX_PATH, MAX_PICKED) || !isTextList(ids, MAX_EXTERNAL_ID)) refuse(CH.onenoteStartBackup)
    return importer().startBackup(paths, ids)
  })
  ipc.handle(CH.onenoteStatus, () => auth.status())
  ipc.handle(CH.onenoteSignIn, () => auth.signIn())
  ipc.handle(CH.onenoteSignOut, () => auth.signOut())
  ipc.handle(CH.onenoteTree, () => importer().tree())
  ipc.handle(CH.onenoteStart, (_e, ids: unknown) => {
    if (!isTextList(ids, MAX_EXTERNAL_ID)) refuse(CH.onenoteStart)
    return importer().start(ids)
  })
  ipc.handle(CH.onenoteRetry, () => importer().retryFailed())
  ipc.handle(CH.onenoteCancel, () => importer().cancel())
  ipc.handle(CH.onenoteSetClientId, (_e, id: unknown) => {
    if (!isName(id)) refuse(CH.onenoteSetClientId)
    setClientId(id.trim())
  })
}
