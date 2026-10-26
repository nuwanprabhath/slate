import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NO_WINDOW_RESTORE } from '../e2e/fixtures'
import { V010_MAC_MAIN, must, run, type Bed } from './bed'

export type Version = 'current' | 'v0.1.0'

export interface StartOptions {
  version: Version
  env?: Record<string, string>
  /** Ubuntu only: a desktop session with gnome-keyring unlocked (default), or none at all. */
  keyring?: boolean
}

/** One computer in a scenario: a data folder that outlives app restarts, and the app running on it. */
export interface Device {
  readonly label: 'Mac' | 'Ubuntu'
  /** The shared bare repository as this device's git URL. */
  readonly remoteUrl: string
  start(opts: StartOptions): Promise<Page>
  /** Quits the app (as a user quitting would) and waits for it to exit. */
  stop(): Promise<void>
  /** The open windows, newest last. */
  windows(): Page[]
  /** A file in the data folder, or null. */
  readFile(name: string): Promise<string | null>
  /** The app's own output so far (Ubuntu); empty on the Mac, where Playwright holds it. */
  log(): Promise<string>
}

/** Settings every launch of the current build gets: syncs back to back, and a fast KDF for new vaults. */
function baseEnv(version: Version): Record<string, string> {
  return version === 'current' ? { SLATE_SYNC_INTERVAL_MS: '500', SLATE_TEST_WEAK_KDF: '1' } : { SLATE_SYNC_INTERVAL_MS: '500' }
}

export function macDevice(dir: string, bare: string): Device {
  const data = join(dir, 'mac-data')
  let app: ElectronApplication | null = null
  return {
    label: 'Mac',
    remoteUrl: `file://${bare}`,
    async start(opts) {
      mkdirSync(data, { recursive: true })
      const main = opts.version === 'current' ? join(__dirname, '..', 'out', 'main', 'index.js') : V010_MAC_MAIN
      const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env
      app = await electron.launch({
        args: [main, ...NO_WINDOW_RESTORE],
        env: { ...(inherited as Record<string, string>), ...baseEnv(opts.version), ...opts.env, SLATE_E2E: '1', SLATE_USER_DATA: data },
      })
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      return page
    },
    async stop() {
      const a = app
      app = null
      await a?.close()
    },
    windows: () => app?.windows().filter((w) => !w.isClosed()) ?? [],
    async readFile(name) {
      const path = join(data, name)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    },
    log: () => Promise.resolve(''),
  }
}

/** The app in the container, under xvfb, driven over the Chrome DevTools Protocol on the published port. */
export function ubuntuDevice(bed: Bed, scenario: string): Device {
  const data = `/home/dev/xdev/${scenario}`
  let browser: Browser | null = null
  const exec = (args: string[]) => run('docker', ['exec', bed.name, ...args])
  const running = async () => (await exec(['pgrep', '-f', 'remote-debugging-port=9222'])).code === 0
  return {
    label: 'Ubuntu',
    remoteUrl: `file:///remote/${scenario}/notes.git`,
    async start(opts) {
      if (await running()) throw new Error('an app is already running in the container')
      const env = { ...baseEnv(opts.version), ...opts.env }
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      await must('docker', ['exec', '-d', ...envArgs, bed.name, 'slate-run', opts.version === 'current' ? 'current' : 'v010', data, opts.keyring === false ? 'no-keyring' : 'keyring'])
      const url = `http://127.0.0.1:${String(bed.port)}`
      await expect
        .poll(
          async () => {
            try {
              return (await fetch(`${url}/json/version`)).ok
            } catch {
              return false
            }
          },
          { timeout: 60_000, intervals: [250, 500, 1000] },
        )
        .toBe(true)
      browser = await chromium.connectOverCDP(url)
      let page: Page | undefined
      await expect.poll(() => (page = this.windows()[0]) !== undefined, { timeout: 30_000 }).toBe(true)
      await page!.waitForLoadState('domcontentloaded')
      return page!
    },
    async stop() {
      const b = browser
      browser = null
      await b?.close().catch(() => {})
      // SIGTERM is Electron's quit: windows close and the app's shutdown runs as on a desktop logout.
      await exec(['pkill', '-TERM', '-f', 'remote-debugging-port=9222'])
      await expect.poll(running, { timeout: 20_000 }).toBe(false).catch(async () => {
        await exec(['pkill', '-KILL', '-f', 'remote-debugging-port=9222'])
        await expect.poll(running, { timeout: 10_000 }).toBe(false)
      })
    },
    windows: () => browser?.contexts().flatMap((c) => c.pages()).filter((p) => !p.isClosed()) ?? [],
    async readFile(name) {
      const r = await exec(['cat', `${data}/${name}`])
      return r.code === 0 ? r.stdout : null
    },
    async log() {
      return (await exec(['cat', `${data}.out`])).stdout
    },
  }
}
