import type { Settings } from '../shared/api'
import { mergeSettings, sanitizePatch } from '../shared/settings/schema'
import type { DocStore } from './store'

type Listener = (settings: Settings) => void
const listeners = new Set<Listener>()

/** Called with the full settings after every write, whoever made it (a window, the menu, sync). */
export function onSettingsWritten(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readSettings(store: DocStore): Settings {
  // Phase 4 stored OneDrive sync as `syncEnabled`; a provider saved since takes precedence.
  const { syncEnabled, ...stored } = store.getSetting<Record<string, unknown>>('settings') ?? {}
  const migrated = stored.syncProvider === undefined && syncEnabled === true ? { syncProvider: 'onedrive' } : {}
  return mergeSettings({ ...migrated, ...stored })
}

export function writeSettings(store: DocStore, patch: Partial<Settings>): Settings {
  const next = { ...readSettings(store), ...sanitizePatch(patch) }
  store.setSetting('settings', next)
  listeners.forEach((l) => l(next))
  return next
}
