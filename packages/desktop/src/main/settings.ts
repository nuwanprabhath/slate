import { DEFAULT_SETTINGS, type Settings } from '../shared/api'
import type { DocStore } from './store'

/** Phase 4 stored OneDrive sync as `syncEnabled`; a provider saved since takes precedence. */
type Stored = Partial<Settings> & { syncEnabled?: boolean }

export function readSettings(store: DocStore): Settings {
  const { syncEnabled, ...stored } = store.getSetting<Stored>('settings') ?? {}
  const migrated = stored.syncProvider === undefined && syncEnabled === true ? { syncProvider: 'onedrive' as const } : {}
  return { ...DEFAULT_SETTINGS, ...migrated, ...stored }
}

export function writeSettings(store: DocStore, patch: Partial<Settings>): Settings {
  const next = { ...readSettings(store), ...patch }
  store.setSetting('settings', next)
  return next
}
