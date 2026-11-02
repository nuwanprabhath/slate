import type { InstallOutcome } from '../../shared/api'
import { CH } from '../../shared/ipc'
import { passwordBytes } from '../../shared/secret'
import { secretHandler } from '../vaultIpc'
import type { DocStore } from '../store'
import type { UpdatePrefs, UpdateService } from './updateService'

const BAD_PASSWORD: InstallOutcome = { ok: false, reason: 'install', message: 'The password was not sent as the bytes of a non-empty secret.' }

interface Handles {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export function registerUpdateIpc(ipc: Handles, service: UpdateService): void {
  ipc.handle(CH.updateState, () => service.state())
  ipc.handle(CH.updateCheck, () => service.check({ manual: true }))
  ipc.handle(CH.updateDownload, () => service.download())
  ipc.handle(CH.updateInstall, () => service.install())
  ipc.handle(CH.updatePrepareInstall, () => service.prepareInstall())
  // The password is bytes or null, never text; secretHandler zeroes main's copy when the call settles.
  ipc.handle(
    CH.updateInstallAndRestart,
    secretHandler(async (password) => {
      if (password === null) return service.installAndRestart(null)
      const bytes = passwordBytes(password)
      return bytes === null ? BAD_PASSWORD : service.installAndRestart(bytes)
    }),
  )
  ipc.handle(CH.updateOpenInstaller, () => service.openInstaller())
  ipc.handle(CH.updateShowInFolder, () => service.showInFolder())
  ipc.handle(CH.updateCopyCommand, () => service.copyCommand())
  ipc.handle(CH.updateCopyReleaseUrl, () => service.copyReleaseUrl())
  ipc.handle(CH.updateSkip, () => service.skip())
  ipc.handle(CH.updateUnskip, () => service.unskip())
  ipc.handle(CH.updateDismiss, () => service.dismiss())
}

/** A key of its own, so the renderer's settings never carry update bookkeeping. */
export function updatePrefsIn(store: DocStore): { load(): UpdatePrefs; save(prefs: UpdatePrefs): void } {
  return {
    load: () => store.getSetting<UpdatePrefs>('update') ?? {},
    save: (prefs) => store.setSetting('update', prefs),
  }
}
