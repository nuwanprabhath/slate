/**
 * Data-subject rights: export everything, erase a document's history, erase all (GDPR review §3.5).
 * The work is in `export.ts` and `erase.ts`; this file binds them to the open services and Electron.
 */
import { join } from 'node:path'
import { BrowserWindow, dialog, session } from 'electron'
import type { ExportReport, Settings } from '../../shared/api'
import type { BlobStore } from '../blobs'
import { log } from '../log/logger'
import type { AuthService } from '../onenote/auth'
import type { SearchIndex } from '../search/searchIndex'
import { secretFile, type SecretStorage } from '../secretStorage'
import type { DocStore } from '../store'
import type { SyncService } from '../sync/syncService'
import type { VaultBusy } from '../vault/busy'
import type { ProfileId } from '../vault/profile'
import { eraseDocHistory, eraseEverything, historyEraseBlocker, HistoryEraseUnavailable, HistoryWasSynced, SyncIsOn } from './erase'
import { writeExport } from './export'
import type { Retention } from './retention'

export type { ExportReport }

/** Accessors index.ts builds once; each `() =>` reads the open services at call time and throws `Locked` while closed. */
export interface DataRightsDeps {
  store: () => DocStore
  blobs: () => BlobStore
  search: () => SearchIndex
  sync: () => SyncService
  settings: () => Settings
  /** The data folder (`app.getPath('userData')`). */
  dataDir: string
  /** The open vault's profile; null without a vault. */
  profile: () => ProfileId | null
  appVersion: string
  retention: Retention
  /** The Microsoft sign-in (sign-out before erasing). */
  auth: AuthService
  /** The OS keyring, for the sealed secret files (`createSecretFile`). */
  secrets: SecretStorage
  /** Stops AI access and sync, closes the watch and the databases, as a lock does. */
  closeNotes: () => Promise<void>
  /** Removes quick unlock's keyring entry and file, through the same path as turning it off. */
  forgetQuickUnlock: () => Promise<void>
  /** `app.relaunch()` then `app.exit(0)`. */
  relaunch: () => void
  /** A migration a crash or failure left unfinished on disk (`vault.state === 'migrating'`). */
  unfinishedMigration: () => boolean
  /**
   * The vault's one-change-at-a-time lock. A running encryption, rekey or history replace holds it (its vault state
   * stays 'plaintext' or 'unlocked' until it ends); erase all takes it, so none starts while files are removed.
   */
  busy: VaultBusy
}

/** Erase all waits for a migration: one still running could write its database or a vault file after the listing. */
export class EraseWhileMigrating extends Error {
  constructor() {
    super('Slate is encrypting your notes. Wait until it has finished, or cancel it, then erase everything.')
    this.name = 'EraseWhileMigrating'
  }
}

export interface DataRights {
  /** Asks for a folder (main's dialog); null when the person cancelled. */
  exportAll(): Promise<ExportReport | null>
  eraseHistory(docId: string): Promise<void>
  /** What `eraseHistory(docId)` would refuse with now, as the message it would show; null when it would go ahead. */
  historyEraseBlocker(docId: string): Promise<string | null>
  /** False when the person answered Cancel to main's question (nothing was touched); true once erased, before the relaunch. */
  eraseAll(): Promise<boolean>
}

/** What Electron does for these rights; replaced in unit tests, which run without Electron. */
export interface DataRightsPlatform {
  /** A folder the person picked, or null when they cancelled. */
  pickFolder(): Promise<string | null>
  clearBrowserStorage(): Promise<void>
  /**
   * Main's own question before erase all, whatever the renderer sent: true only when the person chose to erase.
   * The destructive button is never the default one.
   */
  confirmEraseAll(): Promise<boolean>
}

export const electronPlatform: DataRightsPlatform = {
  async pickFolder() {
    const options: Electron.OpenDialogOptions = { title: 'Export everything to…', buttonLabel: 'Export here', properties: ['openDirectory', 'createDirectory'] }
    const win = BrowserWindow.getFocusedWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  },
  async clearBrowserStorage() {
    await session.defaultSession.clearStorageData()
    await session.defaultSession.clearCache()
  },
  async confirmEraseAll() {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: 'Erase all Slate data on this computer?',
      detail: 'Your notes, images, settings, sign-ins and logs are deleted, and Slate restarts. This cannot be undone. Notes you synced stay at your sync provider.',
      buttons: ['Cancel', 'Erase everything'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const win = BrowserWindow.getFocusedWindow()
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return response === 1
  },
}

/** The keyring-sealed files Slate writes (sync's tokens, Microsoft's token cache). */
const SEALED_FILES = [
  ['microsoft token cache', 'msal-cache.bin'],
  ['git token', join('git-sync', 'token.bin')],
  ['github device token', join('git-sync', 'github-device-token.bin')],
] as const

export function createDataRights(deps: DataRightsDeps, platform: DataRightsPlatform = electronPlatform): DataRights {
  return {
    async exportAll() {
      // Read before the dialog, so a locked vault is refused (`Locked`) without asking for a folder.
      const store = deps.store()
      const parent = await platform.pickFolder()
      if (parent === null) return null
      const { manifest, ...report } = await writeExport(parent, {
        store,
        blobs: deps.blobs(),
        settings: deps.settings(),
        securityLog: () => deps.retention.readSecurityLog(),
        appVersion: deps.appVersion,
        now: new Date(),
      })
      if (manifest.errors.length > 0) log.warn('app', 'export left items out', { count: manifest.errors.length })
      return report
    },

    eraseHistory(docId) {
      return Promise.resolve().then(() => {
        const syncOn = deps.settings().syncProvider !== null
        // The person can act on "turn sync off"; say that before what this build cannot do.
        if (syncOn) throw new SyncIsOn()
        const search = deps.search()
        eraseDocHistory(deps.store(), docId, syncOn, (id) => search.docChanged(id))
      })
    },

    historyEraseBlocker(docId) {
      return Promise.resolve().then(() => {
        // The order eraseHistory refuses in: what the person can act on first.
        if (deps.settings().syncProvider !== null) return new SyncIsOn().message
        const blocked = historyEraseBlocker()
        if (blocked !== null) return new HistoryEraseUnavailable(blocked).message
        return deps.store().wasSynced(docId) ? new HistoryWasSynced().message : null
      })
    },

    async eraseAll() {
      const migrating = () => deps.unfinishedMigration() || deps.busy.running
      if (migrating()) throw new EraseWhileMigrating()
      // The renderer's typed ERASE is its own step; main asks again, since a compromised renderer could send the word.
      if (!(await platform.confirmEraseAll())) return false
      // Again after the dialog (a migration may have started while it was open), then under the lock itself.
      if (migrating()) throw new EraseWhileMigrating()
      return deps.busy.run(() => eraseAllNow())
    },
  }

  async function eraseAllNow(): Promise<boolean> {
    const profile = deps.profile()
    const report = await eraseEverything({
      dataDir: deps.dataDir,
      profile,
      signOut: () => deps.auth.signOut(),
      closeNotes: deps.closeNotes,
      secrets: SEALED_FILES.map(([name, file]) => ({ name, clear: () => secretFile(join(deps.dataDir, file), deps.secrets).clear() })),
      forgetQuickUnlock: deps.forgetQuickUnlock,
      clearBrowserStorage: platform.clearBrowserStorage,
      sweepTemp: () => deps.retention.sweepTemp(),
      // Collected, not logged one by one: the logs folder is being erased, and each line would bring a file back.
      warn: () => {},
    })
    if (report.failed.length > 0) log.warn('app', 'erase all left items behind', { failed: report.failed.join(', ') })
    deps.relaunch()
    return true
  }
}
