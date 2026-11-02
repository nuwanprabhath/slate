import { env, envSnapshot } from '../testHooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard } from 'electron'
import type { IpcRegistrar } from '../ipcGuard'
import { CH } from '../../shared/ipc'
import { log as diagLog } from '../log/logger'
import { onSettingsWritten, readSettings } from '../settings'
import type { DocStore } from '../store'
import { detectInstallKind } from './capability'
import { electronBackend } from './electronBackend'
import { FAKE_CURRENT_VERSION, fakeBackend, fakeInstall, fakeInstallKind, fakeSignature } from './fakeBackend'
import { registerUpdateIpc, updatePrefsIn } from './ipc'
import { createPlatformInstaller } from './platformInstaller'
import { PINNED_UPDATE_KEYS } from './signature'
import { createUpdateVerifier } from './verifier'
import { UpdateService, type UpdatePrefs } from './updateService'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'

/** Real updates run only in a packaged app; e2e runs get the fake backend with SLATE_FAKE_UPDATE, or none at all. */
/** `store` is null while the vault is locked: checks then run with the default settings and no saved skips. */
export function createUpdates(store: () => DocStore | null, isE2E: boolean, ipc: IpcRegistrar): UpdateService {
  const fake = isE2E ? env('SLATE_FAKE_UPDATE') : undefined
  const log = (m: unknown) => console.error(m)
  const prefs = {
    load: () => {
      const s = store()
      return s ? updatePrefsIn(s).load() : {}
    },
    save: (p: UpdatePrefs) => {
      const s = store()
      if (s) updatePrefsIn(s).save(p)
    },
  }
  const live = app.isPackaged && !isE2E
  const manifestName = process.platform === 'darwin' ? 'latest-mac.yml' : process.platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'
  const fakeFeed = fake ? fakeBackend({ downloadsDir: tmpdir(), copy: (t) => void clipboard.writeText(t), manifestName, signature: fakeSignature(fake), install: fakeInstall(fake) }) : null
  const diag = diagLog.scoped('update')
  const installer = createPlatformInstaller({ platform: process.platform, resultFile: join(app.getPath('userData'), 'update-result.json'), quit: () => app.quit(), log: diag, downloadsDir: app.getPath('downloads'), scriptsDir: join(process.resourcesPath, 'update') })
  const backend = fakeFeed ?? electronBackend({ downloadsDir: app.getPath('downloads'), log, installer })
  const verifier = createUpdateVerifier({
    // The fake feed's own key exists only in an e2e run; a real feed verifies against the pinned keys alone.
    keys: fakeFeed ? fakeFeed.keys : PINNED_UPDATE_KEYS,
    manifestName,
    // Must match what UpdateService compares against: an e2e run reports the fake current version.
    currentVersion: fake ? FAKE_CURRENT_VERSION : app.getVersion(),
    fetchAsset: (version, name) => backend.fetchAsset(version, name),
  })
  const service = new UpdateService({
    backend,
    verifier,
    kind: fake ? fakeInstallKind(fake) : detectInstallKind({ platform: process.platform, isPackaged: live, env: envSnapshot(), execPath: process.execPath }),
    arch: process.arch,
    currentVersion: fake ? FAKE_CURRENT_VERSION : app.getVersion(),
    loadPrefs: prefs.load,
    savePrefs: prefs.save,
    log,
    diag,
    emit: (state) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.updateStateEvent, state)),
    settings: () => {
      const open = store()
      const s = open ? readSettings(open) : DEFAULT_SETTINGS
      return { automaticChecks: s.updateAutomaticChecks, intervalHours: s.updateCheckIntervalHours }
    },
    ...(fake ? { firstCheckMs: 500 } : {}),
  })
  registerUpdateIpc(ipc, service)
  onSettingsWritten(() => service.settingsChanged())
  if (live || fake) service.start()
  // After the macOS helper ran: a failed install is said in the banner at the next start.
  if (live) service.restorePreviousInstall().catch((e: unknown) => log(e))
  return service
}
