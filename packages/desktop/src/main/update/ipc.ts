import { CH } from '../../shared/ipc'
import type { DocStore } from '../store'
import type { UpdatePrefs, UpdateService } from './updateService'

interface Handles {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export function registerUpdateIpc(ipc: Handles, service: UpdateService): void {
  ipc.handle(CH.updateState, () => service.state())
  ipc.handle(CH.updateCheck, () => service.check({ manual: true }))
  ipc.handle(CH.updateDownload, () => service.download())
  ipc.handle(CH.updateInstall, () => service.install())
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
