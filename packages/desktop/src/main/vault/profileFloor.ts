// `profile-floor.json` (audit §4.5.2 downgrade protection, §4.5.4): the lowest header this device accepts for
// its vault. A header of an older format or a weaker profile is refused like a lower `revision`. The file is
// MAC'd with K_prefs and verified at unlock, like preunlock.json; before unlock it is read unverified, which
// can only make the device refuse a header (an attacker who can write the data folder can deny service anyway).
import { join } from 'node:path'
import type { KeyHandle } from '@slate/native'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { canonicalJson, isDowngrade, profileOf, type VaultHeader } from './header'
import { equalBytes, toBase64, utf8, vaultNative } from './native'
import { isProfileId, profileRank, type ProfileId } from './profile'
import { securityEvent } from '../log/securityEvents'

export const PROFILE_FLOOR_FILE = 'profile-floor.json'

export interface ProfileFloor {
  vaultId: string
  profile: ProfileId
  minHeaderVersion: 1 | 2 | 3
}

interface ProfileFloorFile extends ProfileFloor {
  format: 'slate-profile-floor'
  version: 1
  mac: string
}

/** A header this device's floor refuses (T-POL-05). Unlock reports it as a failed unlock, never as its reason. */
export class HeaderRefused extends Error {
  override name = 'HeaderRefused'
  constructor(readonly reason: 'downgrade') {
    super('This vault header is older or weaker than the one this device already uses')
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KEYS = ['format', 'version', 'vaultId', 'profile', 'minHeaderVersion', 'mac']

/** The floor, or null for anything but a well-formed file: only its own fields, each of the right shape. */
export function parseProfileFloor(json: unknown): ProfileFloor | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const j = json as Record<string, unknown>
  if (Object.keys(j).length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(j, k))) return null
  if (j.format !== 'slate-profile-floor' || j.version !== 1) return null
  if (typeof j.vaultId !== 'string' || !UUID.test(j.vaultId) || !isProfileId(j.profile)) return null
  if (j.minHeaderVersion !== 1 && j.minHeaderVersion !== 2 && j.minHeaderVersion !== 3) return null
  if (typeof j.mac !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(j.mac)) return null
  return { vaultId: j.vaultId, profile: j.profile, minHeaderVersion: j.minHeaderVersion }
}

function mac(floor: ProfileFloor, kPrefs: KeyHandle): Uint8Array {
  const body = { format: 'slate-profile-floor', version: 1, vaultId: floor.vaultId, profile: floor.profile, minHeaderVersion: floor.minHeaderVersion }
  return vaultNative().hmacSha256(kPrefs, utf8(canonicalJson(body)))
}

export function verifyProfileFloor(json: unknown, kPrefs: KeyHandle): ProfileFloor | null {
  const floor = parseProfileFloor(json)
  if (!floor) return null
  return equalBytes(Buffer.from((json as ProfileFloorFile).mac, 'base64'), mac(floor, kPrefs)) ? floor : null
}

async function readFloorJson(dataDir: string): Promise<unknown> {
  try {
    return await readJsonCapped(join(dataDir, PROFILE_FLOOR_FILE))
  } catch {
    return null
  }
}

/** The floor for `vaultId` as the file says, before any key exists; null when there is none for this vault. */
export async function readProfileFloor(dataDir: string, vaultId: string): Promise<ProfileFloor | null> {
  const floor = parseProfileFloor(await readFloorJson(dataDir))
  return floor && floor.vaultId === vaultId ? floor : null
}

/**
 * The floor local-keys v2 records (review C5 L4), read unverified before unlock: its `profile` is bound into the
 * wrap's AAD and checked again once LK opens. Null for a v1 file or none.
 */
export async function readLocalKeysFloor(dataDir: string): Promise<ProfileFloor | null> {
  try {
    const j = (await readJsonCapped(join(dataDir, 'local-keys.json'))) as { version?: unknown; vaultId?: unknown; profile?: unknown }
    if (j.version !== 2 || typeof j.vaultId !== 'string' || !UUID.test(j.vaultId) || !isProfileId(j.profile)) return null
    return { vaultId: j.vaultId, profile: j.profile, minHeaderVersion: 2 }
  } catch {
    return null
  }
}

/** Refuses a header below the floor, before anything is derived from it, and logs `vault.header.refused`. */
export function checkProfileFloor(header: VaultHeader, floor: ProfileFloor | null): void {
  if (!floor || floor.vaultId !== header.vaultId) return
  if (isDowngrade(header, { version: floor.minHeaderVersion, profile: floor.profile })) {
    securityEvent.headerRefused({ reason: 'downgrade', headerVersion: header.version, profile: profileOf(header), floorProfile: floor.profile })
    throw new HeaderRefused('downgrade')
  }
}

/**
 * After unlock with `header`: the floor becomes the higher of the verified floor and the header, signed with
 * K_prefs. A floor that fails its MAC (edited while locked) is replaced; a floor for another vault (this device
 * joined another one) too.
 */
export async function updateProfileFloor(dataDir: string, header: VaultHeader, kPrefs: KeyHandle): Promise<ProfileFloor> {
  const verified = verifyProfileFloor(await readFloorJson(dataDir), kPrefs)
  const prev = verified && verified.vaultId === header.vaultId ? verified : null
  const profile = prev && profileRank(prev.profile) > profileRank(profileOf(header)) ? prev.profile : profileOf(header)
  const minHeaderVersion = Math.max(prev?.minHeaderVersion ?? 1, header.version) as 1 | 2 | 3
  const floor: ProfileFloor = { vaultId: header.vaultId, profile, minHeaderVersion }
  if (!prev || prev.profile !== floor.profile || prev.minHeaderVersion !== floor.minHeaderVersion || !verified) {
    const file: ProfileFloorFile = { format: 'slate-profile-floor', version: 1, ...floor, mac: toBase64(mac(floor, kPrefs)) }
    await writeJsonAtomic(join(dataDir, PROFILE_FLOOR_FILE), file)
  }
  return floor
}
