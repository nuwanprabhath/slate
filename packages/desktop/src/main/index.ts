import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '../shared/ipc'
import { BLOB_SCHEME, BlobStore } from './blobs'
import { createExternalWatch } from './externalWatch'
import { registerIpc, registerOneNoteIpc } from './ipc'
import { buildMenu } from './menu'
import { createAuthService, type AuthService } from './onenote/auth'
import { ImportService } from './onenote/importService'
import { readSettings, writeSettings } from './settings'
import { APP_NAME, defaultUserDataDir, migrateLegacyUserData } from './paths'
import { DocStore } from './store'

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
  protocol.handle(BLOB_SCHEME, (request) => {
    const file = blobs.pathForUrl(request.url)
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 })
  })
  registerIpc(store, blobs)
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
  buildMenu(store)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  const watch = createExternalWatch(store, (batches) =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.externalUpdates, batches)),
  )
  app.on('will-quit', () => {
    watch.stop()
    importer.close()
    store.close()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
