import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { canonicalJson } from './header'
import { decodeB64 } from './kdf'
import { deriveSubkey } from './keyring'
import { destroyKey, toBase64, utf8, vaultNative } from './native'
import { isProfileId, type ProfileId } from './profile'
import { epochOf, SUITE, type KeySchedule } from './suite'

/** `local-keys.json` v1 (§3, §5.2): this device's LK wrapped under K_localwrap (from MK), and which database it opens. */
export interface LocalKeysFileV1 {
  format: 'slate-local-keys'
  version: 1
  vaultId: string
  deviceId: string
  db: string
  nonce: string
  ct: string
}

/**
 * `local-keys.json` v2 (audit §4.5.4): every field but the wrap is in its AAD, so a repointed `db` fails the
 * tag (F-GEN-01; review C1: a planted database name must not make removeStrayDatabases delete the real one).
 * `profile` is the vault's profile when this device joined: the downgrade floor that cannot vanish with
 * profile-floor.json, since deleting this file loses the database key (review C5 L4).
 */
export interface LocalKeysFileV2 {
  format: 'slate-local-keys'
  version: 2
  vaultId: string
  deviceId: string
  profile: ProfileId
  keyEpoch: number
  db: string
  dbCipher: 'sqlcipher-4'
  nonce: string
  ct: string
}

export type LocalKeysFile = LocalKeysFileV1 | LocalKeysFileV2

export class BadLocalKeys extends Error {
  override name = 'BadLocalKeys'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A bare file name in the data folder: the file names the database to open, so no paths.
const DB = /^slate(-[0-9a-f]{8})?\.db$/
const KEYS_V1 = ['format', 'version', 'vaultId', 'deviceId', 'db', 'nonce', 'ct']
const KEYS_V2 = ['format', 'version', 'vaultId', 'deviceId', 'profile', 'keyEpoch', 'db', 'dbCipher', 'nonce', 'ct']

type Bound = Omit<LocalKeysFileV1, 'nonce' | 'ct'> | Omit<LocalKeysFileV2, 'nonce' | 'ct'>

function aad(f: Bound): Uint8Array {
  if (f.version === 1) return utf8(`slate-lk/v1|${f.vaultId}|${f.deviceId}`)
  const { nonce: _n, ct: _c, ...bound } = f as LocalKeysFileV2
  return utf8(`slate-lk/v2|${canonicalJson(bound)}`)
}

/** The local-keys format a key schedule writes: v1 for a suite-0x01 vault, v2 for suite 0x02. */
const versionFor = (schedule: KeySchedule): 1 | 2 => (schedule.suite === SUITE.HKDF_AES256GCM ? 1 : 2)

/**
 * A fresh database key, made in the module and wrapped once, fresh, under this vault's K_localwrap: a database
 * key never moves to another KEK (review C4 M1-R). The caller owns the returned `lk` and destroys it (or hands
 * it to a KeyRing).
 */
export function createLocalKeys(mk: KeyHandle, schedule: KeySchedule, vaultId: string, deviceId: string, dbFile: string, keyEpoch = epochOf(schedule)): { json: LocalKeysFile; lk: KeyHandle } {
  if (!UUID.test(vaultId) || !UUID.test(deviceId)) throw new Error('vaultId and deviceId must be uuids')
  if (!DB.test(dbFile)) throw new Error(`Not a database file name: ${dbFile}`)
  const bound: Bound =
    versionFor(schedule) === 1
      ? { format: 'slate-local-keys', version: 1, vaultId, deviceId, db: dbFile }
      : { format: 'slate-local-keys', version: 2, vaultId, deviceId, profile: schedule.profile, keyEpoch, db: dbFile, dbCipher: 'sqlcipher-4' }
  const n = vaultNative()
  const lk = n.keyRandom('db')
  const kWrap = deriveSubkey(mk, 'localwrap', schedule)
  try {
    const sealed = n.gcmSealKey(kWrap, lk, null, aad(bound))
    return { json: { ...bound, nonce: toBase64(sealed.subarray(0, 12)), ct: toBase64(sealed.subarray(12)) } as LocalKeysFile, lk }
  } catch (e) {
    destroyKey(lk)
    throw e
  } finally {
    destroyKey(kWrap)
  }
}

/** Strict parse of either version: only its own fields, every one of the right shape; BadLocalKeys otherwise. */
export function parseLocalKeys(json: unknown): { bound: Bound; nonce: Uint8Array; ct: Uint8Array } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new BadLocalKeys('Not a local keys file')
  const j = json as Record<string, unknown>
  const want = j.version === 2 ? KEYS_V2 : KEYS_V1
  const keys = Object.keys(j)
  if (keys.length !== want.length || !want.every((k) => Object.hasOwn(j, k))) throw new BadLocalKeys('Unexpected fields')
  if (j.format !== 'slate-local-keys' || (j.version !== 1 && j.version !== 2)) throw new BadLocalKeys('Not a local keys file')
  const { vaultId, deviceId, db } = j
  if (typeof vaultId !== 'string' || !UUID.test(vaultId)) throw new BadLocalKeys('Bad vaultId')
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)) throw new BadLocalKeys('Bad deviceId')
  if (typeof db !== 'string' || !DB.test(db)) throw new BadLocalKeys('Bad db')
  const nonce = decodeB64(j.nonce)
  const ct = decodeB64(j.ct)
  if (!nonce || nonce.length !== 12 || !ct || ct.length !== 48) throw new BadLocalKeys('Bad wrap')
  if (j.version === 1) return { bound: { format: 'slate-local-keys', version: 1, vaultId, deviceId, db }, nonce, ct }
  if (!Number.isSafeInteger(j.keyEpoch) || (j.keyEpoch as number) < 0 || (j.keyEpoch as number) > 4294967295) throw new BadLocalKeys('Bad keyEpoch')
  if (j.dbCipher !== 'sqlcipher-4') throw new BadLocalKeys('Unknown database cipher')
  if (!isProfileId(j.profile)) throw new BadLocalKeys('Unknown profile')
  return { bound: { format: 'slate-local-keys', version: 2, vaultId, deviceId, profile: j.profile, keyEpoch: j.keyEpoch as number, db, dbCipher: 'sqlcipher-4' }, nonce, ct }
}

/**
 * LK is unwrapped straight into the module; the database name it returns is authenticated for a v2 file.
 * The caller owns the returned `lk` and destroys it; the wrapping subkey is destroyed here. A file of the
 * other suite's version (a v1 file under a v2 vault, or the reverse) does not belong to this vault.
 */
export function readLocalKeys(json: unknown, mk: KeyHandle, schedule: KeySchedule): { lk: KeyHandle; db: string; deviceId: string; vaultId: string; profile: ProfileId } {
  const { bound, nonce, ct } = parseLocalKeys(json)
  if (bound.version !== versionFor(schedule)) throw new BadLocalKeys('This device key does not belong to this vault')
  const kWrap = deriveSubkey(mk, 'localwrap', schedule)
  try {
    const profile = bound.version === 2 ? bound.profile : 'standard'
    return { lk: vaultNative().gcmOpenKey(kWrap, nonce, aad(bound), ct, 'db'), db: bound.db, deviceId: bound.deviceId, vaultId: bound.vaultId, profile }
  } catch (e) {
    if (nativeErrorCode(e) === 'SCC_12') throw e
    throw new BadLocalKeys('This device key does not belong to this vault')
  } finally {
    destroyKey(kWrap)
  }
}
