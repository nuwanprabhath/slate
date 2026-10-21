import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface UpdateConfig {
  url: string
}

export interface Updater {
  checkForUpdatesAndNotify(): Promise<unknown>
}

export interface UpdateHandle {
  enabled: boolean
  checkNow(): void
  stop(): void
}

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 6 * 3600_000

/** The build writes update.json beside the app only when SLATE_UPDATE_URL was set, so no file means updates are off. */
export function updateConfig(resourcesPath: string): UpdateConfig | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(resourcesPath, 'update.json'), 'utf8'))
    const url = (parsed as { url?: unknown } | null)?.url
    return typeof url === 'string' && url !== '' ? { url } : null
  } catch {
    return null
  }
}

/** Errors only reach the log: an offline update server must never put a dialog in front of someone typing. */
export function startUpdates(config: UpdateConfig | null, deps: { updater: Updater; log: (message: unknown) => void }): UpdateHandle {
  if (!config) return { enabled: false, checkNow() {}, stop() {} }
  const checkNow = () => {
    deps.updater.checkForUpdatesAndNotify().catch((e: unknown) => deps.log(`update check failed: ${String(e)}`))
  }
  let every: ReturnType<typeof setInterval> | undefined
  const first = setTimeout(() => {
    checkNow()
    every = setInterval(checkNow, CHECK_EVERY_MS)
  }, FIRST_CHECK_MS)
  return {
    enabled: true,
    checkNow,
    stop() {
      clearTimeout(first)
      if (every) clearInterval(every)
    },
  }
}
