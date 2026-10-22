import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, shell } from 'electron'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '../shared/ipc'
import { BLOB_SCHEME, BlobStore } from './blobs'
import { createExternalWatch } from './externalWatch'
import { registerIpc, registerOneNoteIpc, registerSearchIpc, registerSyncIpc } from './ipc'
import { configureLogging, logIpcRejections, registerDiagnosticsIpc } from './log/configure'
import { log } from './log/logger'
import { buildMenu, syncMenuChecks } from './menu'
import { SearchIndex } from './search/searchIndex'
import { launcherInfo } from './mcpLauncher'
import { createUpdates } from './update'
import { createAuthService, type AuthService } from './onenote/auth'
import { converterPath, defaultConverterDirs } from './onenote/backup'
import { ImportService } from './onenote/importService'
import { acquireLock } from './lock'
import { readSettings, writeSettings } from './settings'
import { APP_NAME, defaultUserDataDir, migrateLegacyUserData } from './paths'
import { DocStore } from './store'
import { SyncService } from './sync/syncService'
import { registerThemeIpc, windowBackground } from './theme/ipc'

app.setName(APP_NAME)
const userData = defaultUserDataDir()
if (!process.env.SLATE_USER_DATA) migrateLegacyUserData(userData)
app.setPath('userData', userData)
const isE2E = process.env.SLATE_E2E === '1'

protocol.registerSchemesAsPrivileged([{ scheme: BLOB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// Relative to out/main/index.js, which sits two levels below the package root both in dev and inside
// a packaged app, so `resources/` only has to be included in the package files.
const iconPath = join(__dirname, '../../resources/icon.png')

function createWindow(backgroundColor = '#1e1e1e'): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Slate',
    backgroundColor,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !isE2E,
    },
  })
  // E2E runs keep the window hidden so tests never pop windows onto the user's screen. CI shows it
  // on its virtual display (SLATE_E2E_SHOW): on X11 a window never shown gets almost no frames, and
  // typing there waited on them (500 ms a key, with the renderer idle).
  if (!isE2E || process.env.SLATE_E2E_SHOW === '1') win.once('ready-to-show', () => win.show())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

void app.whenReady().then(() => {
  if (!app.isPackaged) app.dock?.setIcon(iconPath)
  const dataDir = app.getPath('userData')
  // Tells the headless import CLI that this process has the database open.
  const releaseLock = acquireLock(dataDir)
  const store = new DocStore(join(dataDir, 'slate.db'))
  const blobs = new BlobStore(join(dataDir, 'blobs'))
  let sync: SyncService | undefined
  logIpcRejections()
  configureLogging(readSettings(store))
  registerDiagnosticsIpc()
  protocol.handle(BLOB_SCHEME, async (request) => {
    const file = blobs.pathForUrl(request.url)
    if (!file) return new Response('Not found', { status: 404 })
    // An image added on another device arrives with its page; its bytes are fetched on first view.
    if ((await sync?.ensureBlob(basename(file))) === false) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  const search = new SearchIndex(store)
  registerIpc(
    store,
    blobs,
    (docId) => {
      sync?.edited()
      search.docChanged(docId)
    },
    (docId) => search.docRemoved(docId),
  )
  registerSearchIpc(search)
  // After the window is asked for, not before; a query arriving first waits behind it.
  setTimeout(() => search.ensureBuilt(), 0)
  // out/main sits four levels under the repo root when running from a checkout.
  ipcMain.handle(CH.mcpLauncher, () =>
    launcherInfo({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: join(__dirname, '../../../..'), platform: process.platform }),
  )
  const makeAuth = () =>
    createAuthService({
      clientId: process.env.SLATE_MS_CLIENT_ID ?? readSettings(store).msClientId ?? null,
      cacheFile: join(dataDir, 'msal-cache.bin'),
      openBrowser: (url) => shell.openExternal(url),
      fake: isE2E && process.env.SLATE_FAKE_AUTH === '1',
    })
  // Saving a client id swaps the MSAL client underneath the service.
  let auth = makeAuth()
  const currentAuth: AuthService = {
    status: () => auth.status(),
    signIn: () => auth.signIn(),
    signOut: () => auth.signOut(),
    token: (scopes) => auth.token(scopes),
  }
  const importer = new ImportService({
    dbFile: join(dataDir, 'slate.db'),
    blobs,
    auth: currentAuth,
    graphUrl: process.env.SLATE_GRAPH_URL ?? 'https://graph.microsoft.com/v1.0',
    emit: (p) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.onenoteProgress, p)),
    converter: converterPath(defaultConverterDirs()),
    log: log.scoped('import'),
  })
  registerOneNoteIpc(currentAuth, importer, (id) => {
    writeSettings(store, { msClientId: id || null })
    auth = makeAuth()
  })
  const toWindows = (channel: string, payload: unknown) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload))
  const intervalMs = Number(process.env.SLATE_SYNC_INTERVAL_MS)
  sync = new SyncService({
    dbFile: join(dataDir, 'slate.db'),
    blobs,
    auth: currentAuth,
    graphUrl: process.env.SLATE_GRAPH_URL ?? 'https://graph.microsoft.com/v1.0',
    gitDir: join(dataDir, 'git-sync'),
    secrets: safeStorage,
    ...(process.env.SLATE_GITHUB_CLIENT_ID ? { githubClientId: process.env.SLATE_GITHUB_CLIENT_ID } : {}),
    ...(intervalMs > 0 ? { intervalMs } : {}),
    emitStatus: (state) => toWindows(CH.syncStatusEvent, state),
    emitNotice: (message) => toWindows(CH.syncNotice, message),
    log: log.scoped('sync'),
  })
  registerSyncIpc(sync)
  sync.start()
  // Updates are optional: whatever goes wrong setting them up must not stop the window opening.
  let updates: ReturnType<typeof createUpdates> | undefined
  try {
    updates = createUpdates(store, isE2E)
  } catch (e) {
    console.error('update checks are off:', e)
  }
  const themes = registerThemeIpc(store, isE2E)
  buildMenu(store, () => void updates?.check({ manual: true }))
  syncMenuChecks()
  createWindow(windowBackground(store, themes))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(windowBackground(store, themes))
  })
  const watch = createExternalWatch(
    store,
    (batches) => {
      // Agents and sync write through other connections; their page and notebook edits re-index here.
      for (const { docId } of batches) search.docChanged(docId)
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.externalUpdates, batches))
    },
    log.scoped('watch'),
  )
  app.on('will-quit', () => {
    watch.stop()
    search.close()
    updates?.stop()
    sync?.close()
    importer.close()
    store.close()
    releaseLock()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
