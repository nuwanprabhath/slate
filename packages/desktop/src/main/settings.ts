import type { Settings } from '../shared/api'
import { DISCLOSURES, type ConsentFeature, type Consents } from '../shared/privacy/consent'
import { mergeSettings, sanitizePatch } from '../shared/settings/schema'
import type { DocStore } from './store'
import { allowLocalGitRemotes } from './testHooks'

type Listener = (settings: Settings) => void
const listeners = new Set<Listener>()

/** Called with the full settings after every write, whoever made it (a window, the menu, sync). */
export function onSettingsWritten(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What the settings row cannot say about an existing install: whether an encrypted vault holds its notes. */
let legacyContext: { encrypted: () => boolean } = { encrypted: () => false }

/** index.ts says, before any store opens, how to tell whether the notes are encrypted (decides `plaintextSync`). */
export function setLegacyPrivacyContext(context: { encrypted: () => boolean }): void {
  legacyContext = context
}

/**
 * GDPR review §3.1 step 4 (the maintainer's decision): an install from before strict mode keeps the features it
 * already uses, each as a `legacy` grant the "Review privacy settings" card then asks about.
 */
function legacyConsents(s: Settings, encrypted: boolean): Consents {
  const used: ConsentFeature[] = []
  if (s.syncProvider === 'git') used.push('gitSync')
  if (s.syncProvider === 'onedrive') used.push('oneDriveSync')
  if (s.syncProvider !== null && !encrypted) used.push('plaintextSync')
  if (s.updateAutomaticChecks) used.push('updates')
  // OneDrive sync refreshes its Microsoft token through the same sign-in.
  if (s.msClientId !== null || s.syncProvider === 'onedrive') used.push('microsoftSignIn')
  const grantedAt = Date.now()
  return Object.fromEntries(used.map((f) => [f, { grantedAt, textVersion: DISCLOSURES[f].textVersion, source: 'legacy' }]))
}

export function readSettings(store: DocStore): Settings {
  const row = store.getSetting<Record<string, unknown>>('settings')
  // Phase 4 stored OneDrive sync as `syncEnabled`; a provider saved since takes precedence.
  const { syncEnabled, ...stored } = row ?? {}
  const migrated = stored.syncProvider === undefined && syncEnabled === true ? { syncProvider: 'onedrive' } : {}
  const settings = mergeSettings({ ...migrated, ...stored }, { allowLocal: allowLocalGitRemotes() })
  if (row === undefined || 'gdprStrictMode' in stored) return settings
  // Written once, without telling listeners: nothing they act on changed, and index.ts re-arms updates itself.
  const next: Settings = { ...settings, gdprStrictMode: true, consents: legacyConsents(settings, legacyContext.encrypted()) }
  store.setSetting('settings', next)
  return next
}

export function writeSettings(store: DocStore, patch: Partial<Settings>, options: { fromRenderer?: boolean } = {}): Settings {
  const next = { ...readSettings(store), ...sanitizePatch(patch, { allowLocal: allowLocalGitRemotes(), ...options }) }
  store.setSetting('settings', next)
  listeners.forEach((l) => l(next))
  return next
}
