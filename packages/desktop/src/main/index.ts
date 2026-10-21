import { app, BrowserWindow, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BLOB_SCHEME, BlobStore } from './blobs'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { DocStore } from './store'

if (process.env.SLATE_USER_DATA) app.setPath('userData', process.env.SLATE_USER_DATA)
const isE2E = process.env.SLATE_E2E === '1'

protocol.registerSchemesAsPrivileged([{ scheme: BLOB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Slate',
    backgroundColor: '#1e1e1e',
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
  const dataDir = app.getPath('userData')
  const store = new DocStore(join(dataDir, 'slate.db'))
  const blobs = new BlobStore(join(dataDir, 'blobs'))
  protocol.handle(BLOB_SCHEME, (request) => {
    const file = blobs.pathForUrl(request.url)
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 })
  })
  registerIpc(store, blobs)
  buildMenu(store)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('will-quit', () => store.close())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
