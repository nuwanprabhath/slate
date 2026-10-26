import type { KeyHandle } from '@slate/native'
import type { MotionSetting } from '../../shared/theme/motion'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { canonicalJson } from './header'
import { equalBytes, toBase64, utf8, vaultNative } from './native'
import { isProfileId, type ProfileId } from './profile'

/** What the lock screen may read before unlock (§6.6). No note content, titles or names. */
export interface PreunlockContent {
  themeId: string
  motion: MotionSetting
  systemTitleBar: boolean
  /** 0 = never. */
  idleMinutes: number
  lockOnSleep: boolean
  lockOnScreenLock: boolean
  quickUnlock: boolean
}

/** v1: the content and its MAC. v2 (audit §4.5.4, a header-v2 vault) adds `format`, `version` and `profile`, all under the MAC. */
export type PreunlockFile = PreunlockContent & { mac: string } & ({} | { format: 'slate-preunlock'; version: 2; profile: ProfileId })

const BOOLS = ['systemTitleBar', 'lockOnSleep', 'lockOnScreenLock', 'quickUnlock'] as const
const MOTIONS: readonly string[] = ['auto', 'full', 'reduced']
const V2_FIELDS = ['format', 'version', 'profile']

/** The values, or null when the file is missing a field, has an extra one, or holds a bad type. */
export function parsePreunlock(json: unknown): PreunlockContent | null {
  return parsePreunlockFile(json)?.content ?? null
}

/** The content and, for a v2 file, its profile; null for anything but a well-formed v1 or v2 file. */
export function parsePreunlockFile(json: unknown): { content: PreunlockContent; profile: ProfileId | null } | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const j = json as Record<string, unknown>
  const v2 = Object.hasOwn(j, 'version')
  if (v2 && (j.format !== 'slate-preunlock' || j.version !== 2 || !isProfileId(j.profile))) return null
  const keys = Object.keys(j).filter((k) => k !== 'mac' && !(v2 && V2_FIELDS.includes(k)))
  if (keys.length !== 3 + BOOLS.length || typeof j.mac !== 'string') return null
  if (typeof j.themeId !== 'string' || j.themeId.length > 100) return null
  if (typeof j.motion !== 'string' || !MOTIONS.includes(j.motion)) return null
  if (!Number.isSafeInteger(j.idleMinutes) || (j.idleMinutes as number) < 0 || (j.idleMinutes as number) > 7 * 24 * 60) return null
  if (!BOOLS.every((k) => typeof j[k] === 'boolean')) return null
  const content: PreunlockContent = {
    themeId: j.themeId,
    motion: j.motion as MotionSetting,
    systemTitleBar: j.systemTitleBar as boolean,
    idleMinutes: j.idleMinutes as number,
    lockOnSleep: j.lockOnSleep as boolean,
    lockOnScreenLock: j.lockOnScreenLock as boolean,
    quickUnlock: j.quickUnlock as boolean,
  }
  return { content, profile: v2 ? (j.profile as ProfileId) : null }
}

function body(content: PreunlockContent, profile: ProfileId | null): Record<string, unknown> {
  return profile === null ? { ...content } : { ...content, format: 'slate-preunlock', version: 2, profile }
}

function mac(content: PreunlockContent, profile: ProfileId | null, kPrefs: KeyHandle): Uint8Array {
  return vaultNative().hmacSha256(kPrefs, utf8(canonicalJson(body(content, profile))))
}

/** `profile` null writes v1 (a header-v1 vault, untouched until C9); a profile writes v2. */
export function signPreunlock(content: PreunlockContent, kPrefs: KeyHandle, profile: ProfileId | null = null): PreunlockFile {
  return { ...body(content, profile), mac: toBase64(mac(content, profile, kPrefs)) } as PreunlockFile
}

/**
 * False means it was edited while locked: the caller restores the values from the encrypted DB. With
 * `profile`, only a v2 file of that profile verifies (a header-v2 vault's file names its profile).
 */
export function verifyPreunlock(json: unknown, kPrefs: KeyHandle, profile: ProfileId | null = null): boolean {
  const file = parsePreunlockFile(json)
  if (!file || file.profile !== profile) return false
  return equalBytes(Buffer.from((json as PreunlockFile).mac, 'base64'), mac(file.content, file.profile, kPrefs))
}

export async function readPreunlock(path: string): Promise<unknown> {
  try {
    return await readJsonCapped(path)
  } catch {
    return null
  }
}

export async function writePreunlock(path: string, content: PreunlockContent, kPrefs: KeyHandle, profile: ProfileId | null = null): Promise<void> {
  await writeJsonAtomic(path, signPreunlock(content, kPrefs, profile))
}
