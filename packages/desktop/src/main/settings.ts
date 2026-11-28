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

/**
 * The privacy choices again, in a settings-table key of their own. A version from before strict mode rewrites the
 * `settings` row with only its own keys, dropping `gdprStrictMode` and `consents`; this key it never touches, so
 * after a downgrade and an upgrade the choices come back from here instead of the legacy migration running again
 * and granting what the person had withdrawn (blast radius R2). Its presence also says the migration has run.
 */
const PRIVACY_KEY = 'privacy'
type PrivacyMirror = Pick<Settings, 'gdprStrictMode' | 'consents'>

function mirrorPrivacy(store: DocStore, s: Settings): void {
  const mirror: PrivacyMirror = { gdprStrictMode: s.gdprStrictMode, consents: s.consents }
  store.setSetting(PRIVACY_KEY, mirror)
}

/** Canonical JSON (sorted keys), so a copy that differs only in key order is not rewritten on every read. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))

export function readSettings(store: DocStore): Settings {
  const row = store.getSetting<Record<string, unknown>>('settings')
  // Phase 4 stored OneDrive sync as `syncEnabled`; a provider saved since takes precedence.
  const { syncEnabled, ...stored } = row ?? {}
  const migrated = stored.syncProvider === undefined && syncEnabled === true ? { syncProvider: 'onedrive' } : {}
  const settings = mergeSettings({ ...migrated, ...stored }, { allowLocal: allowLocalGitRemotes() })
  if (row === undefined) return settings
  if ('gdprStrictMode' in stored) {
    // The row is the truth while it holds the choices. 0.8.0 and 0.8.1 write the row and no copy, so a grant or a
    // withdrawal they made reaches the copy only here: refresh it whenever it differs, not only when it is missing.
    const mirror: PrivacyMirror = { gdprStrictMode: settings.gdprStrictMode, consents: settings.consents }
    if (canonical(store.getSetting(PRIVACY_KEY)) !== canonical(mirror)) mirrorPrivacy(store, settings)
    return settings
  }
  // Written once, without telling listeners: nothing they act on changed, and index.ts re-arms updates itself.
  const mirror = store.getSetting<Record<string, unknown>>(PRIVACY_KEY)
  const next: Settings =
    mirror !== undefined
      ? mergeSettings({ ...migrated, ...stored, gdprStrictMode: mirror.gdprStrictMode, consents: mirror.consents }, { allowLocal: allowLocalGitRemotes() })
      : { ...settings, gdprStrictMode: true, consents: legacyConsents(settings, legacyContext.encrypted()) }
  store.setSetting('settings', next)
  mirrorPrivacy(store, next)
  return next
}

export function writeSettings(store: DocStore, patch: Partial<Settings>, options: { fromRenderer?: boolean } = {}): Settings {
  const next = { ...readSettings(store), ...sanitizePatch(patch, { allowLocal: allowLocalGitRemotes(), ...options }) }
  store.setSetting('settings', next)
  mirrorPrivacy(store, next)
  listeners.forEach((l) => l(next))
  return next
}
