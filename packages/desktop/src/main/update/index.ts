import { tmpdir } from 'node:os'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import type { DocStore } from '../store'
import { detectInstallKind } from './capability'
import { electronBackend } from './electronBackend'
import { FAKE_CURRENT_VERSION, fakeBackend, fakeInstallKind } from './fakeBackend'
import { registerUpdateIpc, updatePrefsIn } from './ipc'
import { UpdateService } from './updateService'

/** Real updates run only in a packaged app; e2e runs get the fake backend with SLATE_FAKE_UPDATE, or none at all. */
export function createUpdates(store: DocStore, isE2E: boolean): UpdateService {
  const fake = isE2E ? process.env.SLATE_FAKE_UPDATE : undefined
  const log = (m: unknown) => console.error(m)
  const prefs = updatePrefsIn(store)
  const live = app.isPackaged && !isE2E
  const service = new UpdateService({
    backend: fake
      ? fakeBackend({ downloadsDir: tmpdir(), copy: (t) => clipboard.writeText(t) })
      : electronBackend({ downloadsDir: app.getPath('downloads'), log }),
    kind: fake ? fakeInstallKind(fake) : detectInstallKind({ platform: process.platform, isPackaged: live, env: process.env, execPath: process.execPath }),
    arch: process.arch,
    currentVersion: fake ? FAKE_CURRENT_VERSION : app.getVersion(),
    loadPrefs: prefs.load,
    savePrefs: prefs.save,
    log,
    emit: (state) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.updateStateEvent, state)),
    ...(fake ? { firstCheckMs: 500 } : {}),
  })
  registerUpdateIpc(ipcMain, service)
  if (live || fake) service.start()
  return service
}
