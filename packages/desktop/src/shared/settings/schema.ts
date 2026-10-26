/**
 * Every setting, declared once: its default and a `sanitize` that turns whatever is stored or
 * arrives over IPC into a valid value (or `undefined` to reject it). `Settings` in `shared/api.ts`
 * holds the documented type; `SCHEMA` must have an entry for each of its keys, so adding a setting
 * is a field there, an entry here, and its control in `renderer/src/settings/sections/`.
 */
import type { GitAuthMode, GitSettings, Settings, SyncProvider } from '../api'
import { DEFAULT_THEME_ID } from '../theme/builtins'
import { sanitizeFontOverrides } from '../theme/fonts'
import type { MotionSetting } from '../theme/motion'

export interface SettingDef<T> {
  default: T
  /** A valid value for anything that passes, `undefined` for anything that does not. */
  sanitize: (value: unknown) => T | undefined
}

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const stringOrNull = (v: unknown): string | null | undefined => (v === null || typeof v === 'string' ? v : undefined)

const PROVIDERS: readonly SyncProvider[] = ['onedrive', 'git']
const AUTH_MODES: readonly GitAuthMode[] = ['system', 'token', 'gh', 'device']
const MOTIONS: readonly MotionSetting[] = ['auto', 'full', 'reduced']

function gitSettings(v: unknown): GitSettings | null | undefined {
  if (v === null) return null
  if (typeof v !== 'object') return undefined
  const { remoteUrl, branch, auth } = v as Record<string, unknown>
  if (typeof remoteUrl !== 'string' || typeof branch !== 'string' || !AUTH_MODES.some((m) => m === auth)) return undefined
  return { remoteUrl, branch, auth: auth as GitAuthMode }
}

export const SCHEMA: { [K in keyof Settings]: SettingDef<Settings[K]> } = {
  markdownShortcuts: { default: false, sanitize: bool },
  autoBullets: { default: true, sanitize: bool },
  msClientId: { default: null, sanitize: stringOrNull },
  syncProvider: { default: null, sanitize: (v) => (v === null || PROVIDERS.some((p) => p === v) ? (v as SyncProvider | null) : undefined) },
  git: { default: null, sanitize: gitSettings },
  deviceId: { default: null, sanitize: stringOrNull },
  debugLog: { default: false, sanitize: bool },
  plugins: { default: {}, sanitize: (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined) },
  updateAutomaticChecks: { default: true, sanitize: bool },
  updateCheckIntervalHours: { default: 6, sanitize: (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(168, Math.max(1, Math.round(v))) : undefined) },
  themeId: { default: DEFAULT_THEME_ID, sanitize: (v) => (typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : undefined) },
  motion: { default: 'auto', sanitize: (v) => (MOTIONS.some((m) => m === v) ? (v as MotionSetting) : undefined) },
  followSystem: { default: false, sanitize: bool },
  systemTitleBar: { default: false, sanitize: bool },
  fontOverrides: { default: {}, sanitize: sanitizeFontOverrides },
  idleMinutes: { default: 30, sanitize: (v) => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 7 * 24 * 60 ? (v as number) : undefined) },
  lockOnSleep: { default: true, sanitize: bool },
  lockOnScreenLock: { default: true, sanitize: bool },
  quickUnlock: { default: false, sanitize: bool },
}

const KEYS = Object.keys(SCHEMA) as Array<keyof Settings>

export const DEFAULT_SETTINGS: Settings = Object.fromEntries(KEYS.map((k) => [k, SCHEMA[k].default])) as unknown as Settings

/** The known keys of `patch` whose values are valid; everything else is dropped. */
export function sanitizePatch(patch: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const k of KEYS) {
    if (!(k in patch)) continue
    const value = SCHEMA[k].sanitize(patch[k])
    if (value !== undefined) out[k] = value
  }
  return out as Partial<Settings>
}

/** Stored values over the defaults; a bad stored value falls back to its default. */
export function mergeSettings(stored: Record<string, unknown>): Settings {
  return { ...DEFAULT_SETTINGS, ...sanitizePatch(stored) }
}

/**
 * What the vault's profile forces on the Security settings (audit §4.1, AC-11 and AC-12). The numbers repeat
 * `PROFILES` in `main/vault/profile.ts`, which is what main enforces; `profileLimits.test.ts` fails if they differ.
 */
export interface ProfileLimits {
  /** Minutes; null = any value, "Never" included. */
  maxIdleMinutes: number | null
  lockOnSleepForced: boolean
  lockOnScreenLockForced: boolean
}

export function profileLimits(profile: 'standard' | 'fips-140-3' | null): ProfileLimits {
  return profile === 'fips-140-3' ? { maxIdleMinutes: 15, lockOnSleepForced: true, lockOnScreenLockForced: true } : { maxIdleMinutes: null, lockOnSleepForced: false, lockOnScreenLockForced: false }
}

/** The idle lock a stored setting means under `limits`: "Never" (0) and values above the cap become the cap. */
export function shownIdleMinutes(stored: number, limits: ProfileLimits): number {
  if (limits.maxIdleMinutes === null) return stored
  return stored === 0 ? limits.maxIdleMinutes : Math.min(stored, limits.maxIdleMinutes)
}

/** The idle choices a profile allows: no "Never" and nothing above the cap when there is one. */
export function allowedIdleOptions<T extends { value: string }>(options: readonly T[], limits: ProfileLimits): T[] {
  if (limits.maxIdleMinutes === null) return [...options]
  const max = limits.maxIdleMinutes
  return options.filter((o) => Number(o.value) > 0 && Number(o.value) <= max)
}
