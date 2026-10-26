import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { clipboard, net } from 'electron'
import { openExternalSafe, openLocalPath, revealInFolder } from '../openExternal'
import { autoUpdater, type AppUpdater } from 'electron-updater'
import { UpdateSignatureError } from './signature'
import type { UpdateBackend } from './updateService'
import { sameRelease, type VerifiedRelease } from './verifier'
import { assetUrl } from './versions'

type RunFn = (file: string, args: string[]) => Promise<unknown>
/** Feeds are a few KiB and signature files a few hundred bytes. */
const MAX_ASSET_BYTES = 1024 * 1024
const execFileAsync = promisify(execFile)

/**
 * Sets `com.apple.quarantine` on a verified download so Gatekeeper still evaluates the dmg; a file
 * written from a stream carries no quarantine flag. Best-effort and macOS-only.
 */
export async function setQuarantine(path: string, run: RunFn = execFileAsync): Promise<void> {
  const hexTime = Math.floor(Date.now() / 1000).toString(16)
  await run('xattr', ['-w', 'com.apple.quarantine', `0081;${hexTime};Slate;`, path])
}

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
  /**
   * electron-updater downloads and installs what its last checkForUpdates cached, which any later
   * check replaces. Refuse unless that is the release we verified.
   */
  const assertCached = (expected: VerifiedRelease) => {
    const info = (updater() as unknown as { updateInfoAndProvider?: { info?: { version: string; files: Array<{ url: string; sha512: string }> } } | null }).updateInfoAndProvider?.info
    if (!sameRelease(info, expected)) throw new UpdateSignatureError(`electron-updater holds ${info?.version ?? 'no update'}, not the verified ${expected.version}`)
  }
  return {
    async check() {
      const result = await updater().checkForUpdates()
      if (!result) return null
      const info = result.updateInfo
      return { version: info.version, files: info.files.map((f) => ({ url: f.url, sha512: f.sha512, size: f.size ?? 0 })) }
    },
    async downloadAuto(expected, onProgress) {
      assertCached(expected)
      const listener = (p: { percent: number }) => onProgress(p.percent)
      updater().on('download-progress', listener)
      try {
        await updater().downloadUpdate()
      } finally {
        updater().off('download-progress', listener)
      }
    },
    installAuto(expected) {
      assertCached(expected)
      updater().quitAndInstall()
    },
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
        if (process.platform === 'darwin') await setQuarantine(target).catch((e: unknown) => opts.log(e))
        return target
      } catch (e) {
        out.destroy()
        await rm(partial, { force: true })
        throw e
      }
    },
    async fetchAsset(version, name) {
      const url = assetUrl(version, name)
      const res = await net.fetch(url)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.length > MAX_ASSET_BYTES) throw new Error(`GET ${url}: ${bytes.length} bytes is too large`)
      return bytes
    },
    async openPath(path) {
      const error = await openLocalPath(path)
      if (error) throw new Error(error)
    },
    showInFolder: (path) => revealInFolder(path),
    openExternal: (url) => void openExternalSafe(url),
    copy: (text) => void clipboard.writeText(text),
  }
}
