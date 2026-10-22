import type { InstallKind } from '../../shared/api'

export interface InstallEnv {
  platform: NodeJS.Platform
  isPackaged: boolean
  env: Record<string, string | undefined>
  execPath: string
}

/**
 * Releases are unsigned, so Squirrel.Mac cannot install them: a mac gets the dmg to install by hand.
 * The AppImage runtime sets APPIMAGE, and electron-updater can replace that file in place. The .deb
 * installs under /opt and needs root to upgrade, so it gets the apt command.
 */
export function detectInstallKind(e: InstallEnv): InstallKind {
  if (!e.isPackaged) return 'manual'
  if (e.platform === 'darwin') return 'dmg'
  if (e.platform === 'linux') {
    if (e.env.APPIMAGE) return 'auto'
    if (e.execPath.startsWith('/opt/')) return 'deb'
  }
  return 'manual'
}

/** Said in Settings next to the version; an auto install needs no explanation. */
export function capabilityReason(kind: InstallKind): string | undefined {
  switch (kind) {
    case 'auto':
      return undefined
    case 'dmg':
      return "This build can't install updates itself; Slate downloads the installer and opens it."
    case 'deb':
      return "This build can't install updates itself; Slate downloads the .deb and gives you the sudo apt install command."
    case 'manual':
      return "This build can't install updates itself; Slate opens the release page."
  }
}
