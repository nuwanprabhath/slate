import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { clipboard, net, shell } from 'electron'
import { autoUpdater, type AppUpdater } from 'electron-updater'
import type { UpdateBackend } from './updateService'
import { assetUrl } from './versions'

/** Reads the GitHub feed (latest-mac.yml / latest-linux.yml) through electron-updater. */
export function electronBackend(opts: { downloadsDir: string; log: (message: unknown) => void }): UpdateBackend {
  // electron-updater builds its updater on first access, and that throws for a non-semver app
  // version (an unpackaged Linux run reports "0.0"). Touching it only when a check runs keeps that
  // throw inside the update service, which logs it, instead of in app start-up.
  let configured: AppUpdater | undefined
  const updater = (): AppUpdater => {
    if (configured) return configured
    const u = autoUpdater
    u.autoDownload = false
    u.autoInstallOnAppQuit = false
    u.logger = { info: () => {}, warn: opts.log, error: opts.log, debug: () => {} }
    return (configured = u)
  }
  return {
    async check() {
      const result = await updater().checkForUpdates()
      if (!result) return null
      const info = result.updateInfo
      return { version: info.version, files: info.files.map((f) => ({ url: f.url, sha512: f.sha512, size: f.size ?? 0 })) }
    },
    async downloadAuto(onProgress) {
      const listener = (p: { percent: number }) => onProgress(p.percent)
      updater().on('download-progress', listener)
      try {
        await updater().downloadUpdate()
      } finally {
        updater().off('download-progress', listener)
      }
    },
    installAuto: () => updater().quitAndInstall(),
    async downloadFile(file, version, onProgress) {
      const name = basename(file.url)
      const url = /^https?:/.test(file.url) ? file.url : assetUrl(version, name)
      const target = join(opts.downloadsDir, name)
      const partial = `${target}.part`
      const res = await net.fetch(url)
      if (!res.ok || !res.body) throw new Error(`GET ${url}: ${res.status}`)
      const hash = createHash('sha512')
      const out = createWriteStream(partial)
      const total = Number(res.headers.get('content-length')) || file.size
      let received = 0
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk)
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
          received += chunk.length
          if (total > 0) onProgress((received / total) * 100)
        }
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
        if (hash.digest('base64') !== file.sha512) throw new Error(`sha512 mismatch for ${name}`)
        await rename(partial, target)
        return target
      } catch (e) {
        out.destroy()
        await rm(partial, { force: true })
        throw e
      }
    },
    async openPath(path) {
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    },
    showInFolder: (path) => shell.showItemInFolder(path),
    openExternal: (url) => void shell.openExternal(url),
    copy: (text) => clipboard.writeText(text),
  }
}
