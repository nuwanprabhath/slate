import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EncryptProgress, ExternalBatch, MenuCommand, Settings, SlateApi, SyncState, UpdateState } from '../shared/api'
import type { ImportProgress } from '@slate/importer'
import { CH } from '../shared/ipc'
import { zeroSecret, type SecretBytes } from '../shared/secret'
import type { SavedTheme } from '../shared/theme/resolve'

/**
 * Z-5 (C7): a secret reaches main once, as bytes. contextBridge gives this preload its own copy of the page's
 * array; it is zeroed when the call settles (the page zeroes its own, main the one it receives).
 */
function settle<T>(call: Promise<T>, ...secrets: Array<SecretBytes | undefined>): Promise<T> {
  return call.finally(() => zeroSecret(...secrets))
}
const secretIn = (s: { password: SecretBytes } | { recoveryKey: SecretBytes }): SecretBytes => ('password' in s ? s.password : s.recoveryKey)

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
    onChange(handler) {
      const listener = (_e: IpcRendererEvent, settings: Settings) => handler(settings)
      ipcRenderer.on(CH.settingsChanged, listener)
      return () => ipcRenderer.removeListener(CH.settingsChanged, listener)
    },
  },
  themes: {
    initial: ipcRenderer.sendSync(CH.themesInitial),
    list: () => ipcRenderer.invoke(CH.themesList),
    save: (spec, prompt) => ipcRenderer.invoke(CH.themesSave, spec, prompt ?? null),
    rename: (id, name) => ipcRenderer.invoke(CH.themesRename, id, name),
    remove: (id) => ipcRenderer.invoke(CH.themesRemove, id),
    onChange(handler) {
      const listener = (_e: IpcRendererEvent, saved: SavedTheme[]) => handler(saved)
      ipcRenderer.on(CH.themesChanged, listener)
      return () => ipcRenderer.removeListener(CH.themesChanged, listener)
    },
    claudeAvailable: () => ipcRenderer.invoke(CH.themesClaude),
    generate: (request, current) => ipcRenderer.invoke(CH.themesGenerate, request, current),
    cancelGenerate: () => ipcRenderer.invoke(CH.themesCancel),
  },
  audit: { list: (limit) => ipcRenderer.invoke(CH.auditList, limit) },
  diagnostics: {
    status: () => ipcRenderer.invoke(CH.diagnosticsStatus),
    read: () => ipcRenderer.invoke(CH.diagnosticsRead),
    copy: () => ipcRenderer.invoke(CH.diagnosticsCopy),
    clear: () => ipcRenderer.invoke(CH.diagnosticsClear),
    openFolder: () => ipcRenderer.invoke(CH.diagnosticsOpenFolder),
    rendererError: (report) => ipcRenderer.invoke(CH.diagnosticsRendererError, report),
    copyReport: () => ipcRenderer.invoke(CH.diagnosticsCopyReport),
  },
  mcp: { launcherInfo: () => ipcRenderer.invoke(CH.mcpLauncher) },
  clipboardText: () => ipcRenderer.invoke(CH.clipboardText),
  openExternal: (url) => ipcRenderer.invoke(CH.openExternal, url),
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
    checkTransport: () => ipcRenderer.invoke(CH.syncCheckTransport),
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
    opened: (notebookId) => ipcRenderer.invoke(CH.syncOpened, notebookId),
    onOpenNotebook(handler) {
      const listener = (_e: IpcRendererEvent, notebookId: string) => handler(notebookId)
      ipcRenderer.on(CH.syncOpenNotebook, listener)
      return () => ipcRenderer.removeListener(CH.syncOpenNotebook, listener)
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
  search: { query: (query) => ipcRenderer.invoke(CH.searchQuery, query) },
  chrome: {
    kind: ipcRenderer.sendSync(CH.chromeKind),
    platform: process.platform,
    setColors: (colors) => ipcRenderer.send(CH.chromeSetColors, colors),
    toggleMaximize: () => ipcRenderer.send(CH.chromeToggleMaximize),
    menu: () => ipcRenderer.invoke(CH.chromeMenu),
    invokeMenu: (path) => ipcRenderer.send(CH.chromeInvokeMenu, path),
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
  vault: {
    status: () => ipcRenderer.invoke(CH.vaultStatus),
    pqReadiness: () => ipcRenderer.invoke(CH.vaultPqReadiness),
    moduleStatus: () => ipcRenderer.invoke(CH.vaultModuleStatus),
    selfTest: () => ipcRenderer.invoke(CH.vaultSelfTest),
    keysInfo: () => ipcRenderer.invoke(CH.vaultKeysInfo),
    prepareRekey: (kind, password, newPassword) => settle(ipcRenderer.invoke(CH.vaultRekeyPrepare, kind, password, newPassword), password, newPassword),
    runRekey: () => ipcRenderer.invoke(CH.vaultRekeyRun),
    replaceSyncHistory: () => ipcRenderer.invoke(CH.vaultReplaceHistory),
    unlock: (password) => settle(ipcRenderer.invoke(CH.vaultUnlock, password), password),
    unlockRecovery: (recoveryKey) => settle(ipcRenderer.invoke(CH.vaultUnlockRecovery, recoveryKey), recoveryKey),
    quickUnlock: () => ipcRenderer.invoke(CH.vaultQuickUnlock),
    quickUnlockInfo: () => ipcRenderer.invoke(CH.vaultQuickUnlockInfo),
    enableQuickUnlock: (password) => settle(ipcRenderer.invoke(CH.vaultQuickUnlockEnable, password), password),
    disableQuickUnlock: () => ipcRenderer.invoke(CH.vaultQuickUnlockDisable),
    finishMigration: (password) => settle(ipcRenderer.invoke(CH.vaultFinishMigration, password), password),
    cancelMigration: () => ipcRenderer.invoke(CH.vaultCancelMigration),
    checkPassword: (password, profile) => settle(ipcRenderer.invoke(CH.vaultCheckPassword, password, profile), password),
    prepareEncryption: (password, profile) => settle(ipcRenderer.invoke(CH.vaultPrepare, password, profile), password),
    confirmRecovery: (recoveryKey) => settle(ipcRenderer.invoke(CH.vaultConfirmRecovery, recoveryKey), recoveryKey),
    saveRecoveryKey: (recoveryKey) => ipcRenderer.invoke(CH.vaultSaveRecovery, recoveryKey),
    encrypt: () => ipcRenderer.invoke(CH.vaultEncrypt),
    discardEncryption: () => ipcRenderer.invoke(CH.vaultDiscard),
    join: (secret) => settle(ipcRenderer.invoke(CH.vaultJoin, secret), secretIn(secret)),
    encryptRemote: () => ipcRenderer.invoke(CH.vaultEncryptRemote),
    changePassword: (current, next) => settle(ipcRenderer.invoke(CH.vaultChangePassword, current, next), secretIn(current), next),
    newRecoveryKey: (password) => settle(ipcRenderer.invoke(CH.vaultNewRecovery, password), password),
    onProgress(handler) {
      const listener = (_e: IpcRendererEvent, progress: EncryptProgress) => handler(progress)
      ipcRenderer.on(CH.vaultProgress, listener)
      return () => ipcRenderer.removeListener(CH.vaultProgress, listener)
    },
    activity: () => ipcRenderer.send(CH.vaultActivity),
    copied: () => ipcRenderer.send(CH.vaultCopied),
    lock: () => ipcRenderer.send(CH.vaultLock),
    onFlush(handler) {
      const listener = (_e: IpcRendererEvent, id: number) => {
        void handler()
          .catch(() => {})
          .then(() => ipcRenderer.send(CH.vaultFlushed, id))
      }
      ipcRenderer.on(CH.vaultFlush, listener)
      return () => ipcRenderer.removeListener(CH.vaultFlush, listener)
    },
  },
  appVersion: () => ipcRenderer.invoke(CH.appVersion),
  quit: () => ipcRenderer.invoke(CH.appQuit),
}

contextBridge.exposeInMainWorld('slate', api)
