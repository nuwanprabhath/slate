import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '../shared/ipc'
import { BLOB_SCHEME, BlobStore } from './blobs'
import { createExternalWatch } from './externalWatch'
import { registerIpc, registerOneNoteIpc, registerSyncIpc } from './ipc'
import { buildMenu } from './menu'
import { launcherInfo } from './mcpLauncher'
import { startUpdates, updateConfig } from './updates'
import { createAuthService, type AuthService } from './onenote/auth'
import { ImportService } from './onenote/importService'
import { readSettings, writeSettings } from './settings'
import { APP_NAME, defaultUserDataDir, migrateLegacyUserData } from './paths'
import { DocStore } from './store'
import { SyncService } from './sync/syncService'

app.setName(APP_NAME)
const userData = defaultUserDataDir()
if (!process.env.SLATE_USER_DATA) migrateLegacyUserData(userData)
app.setPath('userData', userData)
const isE2E = process.env.SLATE_E2E === '1'

protocol.registerSchemesAsPrivileged([{ scheme: BLOB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// Relative to out/main/index.js, which sits two levels below the package root both in dev and inside
// a packaged app, so `resources/` only has to be included in the package files.
const iconPath = join(__dirname, '../../resources/icon.png')

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Slate',
    backgroundColor: '#1e1e1e',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !isE2E,
    },
  })
  // E2E runs keep the window hidden so tests never pop windows onto the user's screen.
  if (!isE2E) win.once('ready-to-show', () => win.show())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

void app.whenReady().then(() => {
  if (!app.isPackaged) app.dock?.setIcon(iconPath)
  const dataDir = app.getPath('userData')
  const store = new DocStore(join(dataDir, 'slate.db'))
  const blobs = new BlobStore(join(dataDir, 'blobs'))
  let sync: SyncService | undefined
  protocol.handle(BLOB_SCHEME, async (request) => {
    const file = blobs.pathForUrl(request.url)
    if (!file) return new Response('Not found', { status: 404 })
    // An image added on another device arrives with its page; its bytes are fetched on first view.
    if ((await sync?.ensureBlob(basename(file))) === false) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  registerIpc(store, blobs, () => sync?.edited())
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
  })
  registerSyncIpc(sync)
  sync.start()
  // Off unless the build set SLATE_UPDATE_URL (see electron-builder.cjs); never in dev or e2e runs.
  const updates = startUpdates(app.isPackaged && !isE2E ? updateConfig(process.resourcesPath) : null, {
    updater: autoUpdater,
    log: (m) => console.error(m),
  })
  buildMenu(store, updates.enabled ? updates.checkNow : undefined)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  const watch = createExternalWatch(store, (batches) =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.externalUpdates, batches)),
  )
  app.on('will-quit', () => {
    watch.stop()
    updates.stop()
    sync?.close()
    importer.close()
    store.close()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
