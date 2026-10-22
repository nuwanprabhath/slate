import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ExternalBatch, MenuCommand, SlateApi, SyncState, UpdateState } from '../shared/api'
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
  mcp: { launcherInfo: () => ipcRenderer.invoke(CH.mcpLauncher) },
  clipboardText: () => ipcRenderer.invoke(CH.clipboardText),
  onenote: {
    status: () => ipcRenderer.invoke(CH.onenoteStatus),
    signIn: () => ipcRenderer.invoke(CH.onenoteSignIn),
    signOut: () => ipcRenderer.invoke(CH.onenoteSignOut),
    tree: () => ipcRenderer.invoke(CH.onenoteTree),
    start: (ids) => ipcRenderer.invoke(CH.onenoteStart, ids),
    retryFailed: () => ipcRenderer.invoke(CH.onenoteRetry),
    cancel: () => ipcRenderer.invoke(CH.onenoteCancel),
    pickBackup: () => ipcRenderer.invoke(CH.onenotePickBackup),
    startBackup: (paths, sectionIds) => ipcRenderer.invoke(CH.onenoteStartBackup, paths, sectionIds),
    onProgress(handler) {
      const listener = (_e: IpcRendererEvent, p: ImportProgress) => handler(p)
      ipcRenderer.on(CH.onenoteProgress, listener)
      return () => ipcRenderer.removeListener(CH.onenoteProgress, listener)
    },
    setClientId: (id) => ipcRenderer.invoke(CH.onenoteSetClientId, id),
  },
  sync: {
    status: () => ipcRenderer.invoke(CH.syncStatus),
    setEnabled: (on) => ipcRenderer.invoke(CH.syncSetEnabled, on),
    configure: (config) => ipcRenderer.invoke(CH.syncConfigure, config),
    testGit: (git, token) => ipcRenderer.invoke(CH.syncTestGit, git, token),
    gitAuthInfo: () => ipcRenderer.invoke(CH.syncGitAuthInfo),
    createRepo: (name, auth, token) => ipcRenderer.invoke(CH.syncCreateRepo, name, auth, token),
    deviceSignIn: () => ipcRenderer.invoke(CH.syncDeviceSignIn),
    deviceSignInWait: () => ipcRenderer.invoke(CH.syncDeviceSignInWait),
    now: () => ipcRenderer.invoke(CH.syncNow),
    conflicts: (pageId) => ipcRenderer.invoke(CH.syncConflicts, pageId),
    resolve: (id, choice) => ipcRenderer.invoke(CH.syncResolve, id, choice),
    onStatus(handler) {
      const listener = (_e: IpcRendererEvent, state: SyncState) => handler(state)
      ipcRenderer.on(CH.syncStatusEvent, listener)
      return () => ipcRenderer.removeListener(CH.syncStatusEvent, listener)
    },
    onNotice(handler) {
      const listener = (_e: IpcRendererEvent, message: string) => handler(message)
      ipcRenderer.on(CH.syncNotice, listener)
      return () => ipcRenderer.removeListener(CH.syncNotice, listener)
    },
  },
  update: {
    state: () => ipcRenderer.invoke(CH.updateState),
    check: () => ipcRenderer.invoke(CH.updateCheck),
    download: () => ipcRenderer.invoke(CH.updateDownload),
    install: () => ipcRenderer.invoke(CH.updateInstall),
    openInstaller: () => ipcRenderer.invoke(CH.updateOpenInstaller),
    showInFolder: () => ipcRenderer.invoke(CH.updateShowInFolder),
    copyCommand: () => ipcRenderer.invoke(CH.updateCopyCommand),
    copyReleaseUrl: () => ipcRenderer.invoke(CH.updateCopyReleaseUrl),
    skip: () => ipcRenderer.invoke(CH.updateSkip),
    unskip: () => ipcRenderer.invoke(CH.updateUnskip),
    dismiss: () => ipcRenderer.invoke(CH.updateDismiss),
    onState(handler) {
      const listener = (_e: IpcRendererEvent, state: UpdateState) => handler(state)
      ipcRenderer.on(CH.updateStateEvent, listener)
      return () => ipcRenderer.removeListener(CH.updateStateEvent, listener)
    },
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
