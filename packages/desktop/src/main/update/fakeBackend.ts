import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallKind } from '../../shared/api'
import type { UpdateBackend } from './updateService'

export const FAKE_VERSION = '9.9.9'

/** SLATE_FAKE_UPDATE picks the install kind e2e tests exercise; any other value means deb. */
export function fakeInstallKind(value: string): InstallKind {
  return value === 'dmg' || value === 'auto' || value === 'manual' ? value : 'deb'
}

/** For e2e (SLATE_FAKE_UPDATE): always offers 9.9.9 and "downloads" an empty file, never touching the network. */
export function fakeBackend(opts: { downloadsDir: string; copy: (text: string) => void }): UpdateBackend {
  const files = ['mac-arm64.dmg', 'mac-x64.dmg', 'linux-amd64.deb'].map((s) => ({ url: `Slate-${FAKE_VERSION}-${s}`, sha512: 'fake', size: 0 }))
  return {
    check: async () => ({ version: FAKE_VERSION, files }),
    downloadAuto: async (onProgress) => onProgress(100),
    installAuto: () => {},
    async downloadFile(file, _version, onProgress) {
      const path = join(opts.downloadsDir, file.url)
      writeFileSync(path, '')
      onProgress(100)
      return path
    },
    openPath: async () => {},
    showInFolder: () => {},
    openExternal: () => {},
    copy: opts.copy,
  }
}
