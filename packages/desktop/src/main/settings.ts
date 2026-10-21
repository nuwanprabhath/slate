import { DEFAULT_SETTINGS, type Settings } from '../shared/api'
import type { DocStore } from './store'

export function readSettings(store: DocStore): Settings {
  return { ...DEFAULT_SETTINGS, ...store.getSetting<Partial<Settings>>('settings') }
}

export function writeSettings(store: DocStore, patch: Partial<Settings>): Settings {
  const next = { ...readSettings(store), ...patch }
  store.setSetting('settings', next)
  return next
}
