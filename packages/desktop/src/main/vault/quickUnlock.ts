import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { QuickUnlockKind } from '../../shared/api'
import type { SecretStorage } from '../secretStorage'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { canonicalJson, type WrapProof } from './header'
import { decodeB64 } from './kdf'
import { destroyKey, toBase64, utf8, vaultNative } from './native'
import { PROFILES } from './profile'
import { epochOf, SUITE, vidOf, type KeySchedule } from './suite'
import { v1QuickKek } from './suite1'
import { LOCAL_KEYS_FILE, VAULT_FILE } from './unlock'

export const QUICK_UNLOCK_FILE = 'quick-unlock.bin'
export const QUICK_UNLOCK_FALLBACK_MESSAGE = 'Touch ID unavailable — enter your password'
export const TOUCH_ID_REASON = 'unlock your notes'

export type { QuickUnlockKind }

/** The OS keyring (src/main/secretStorage.ts, B-5) and the slice of `systemPreferences` quick unlock uses; tests pass fakes. */
export interface QuickUnlockPlatform {
  platform: NodeJS.Platform
  /** `available()` already refuses Linux's basic_text store, which would put MK one file read away. */
  secrets: SecretStorage
  systemPreferences: { canPromptTouchID?(): boolean; promptTouchID?(reason: string): Promise<void> }
}

/** Says nothing about why: the lock screen falls back to the password either way. */
export class QuickUnlockFailed extends Error {
  override name = 'QuickUnlockFailed'
  constructor() {
    super(QUICK_UNLOCK_FALLBACK_MESSAGE)
  }
}

/** T-POL-06: the fips-140-3 profile has no quick unlock (the biometric is not bound to the key, and the OS keyring is outside the module). */
export class QuickUnlockNotAllowed extends Error {
  override name = 'QuickUnlockNotAllowed'
  constructor() {
    super('Quick unlock is not available for a FIPS 140-3 vault')
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const B64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The audited v1 file (a header-v1 vault): no format or version, read with the same strictness as v2. */
interface QuickUnlockFileV1 {
  vaultId: string
  deviceId: string
  sealedQu: string
  nonce: string
  ct: string
}

/** v2 (audit §4.5.4, F-GEN-03): a strict schema, and every field but the wrap in the AAD. */
interface QuickUnlockFileV2 extends QuickUnlockFileV1 {
  format: 'slate-quick-unlock'
  version: 2
  keyEpoch: number
}

type QuickUnlockFile = QuickUnlockFileV1 | QuickUnlockFileV2

const KEYS_V1 = ['vaultId', 'deviceId', 'sealedQu', 'nonce', 'ct']
const KEYS_V2 = ['format', 'version', 'vaultId', 'deviceId', 'keyEpoch', 'sealedQu', 'nonce', 'ct']

/** The file's fields, or null for anything else (an extra or missing field, a bad shape). Never throws. */
export function parseQuickUnlock(json: unknown): QuickUnlockFile | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const j = json as Record<string, unknown>
  const want = Object.hasOwn(j, 'version') ? KEYS_V2 : KEYS_V1
  if (Object.keys(j).length !== want.length || !want.every((k) => Object.hasOwn(j, k))) return null
  if (typeof j.vaultId !== 'string' || !UUID.test(j.vaultId) || typeof j.deviceId !== 'string' || !UUID.test(j.deviceId)) return null
  if (typeof j.sealedQu !== 'string' || j.sealedQu.length === 0 || j.sealedQu.length > 4096 || !B64.test(j.sealedQu)) return null
  const nonce = decodeB64(j.nonce)
  const ct = decodeB64(j.ct)
  if (!nonce || nonce.length !== 12 || !ct || ct.length !== 48) return null
  const base: QuickUnlockFileV1 = { vaultId: j.vaultId, deviceId: j.deviceId, sealedQu: j.sealedQu, nonce: j.nonce as string, ct: j.ct as string }
  if (want === KEYS_V1) return base
  if (j.format !== 'slate-quick-unlock' || j.version !== 2) return null
  if (!Number.isSafeInteger(j.keyEpoch) || (j.keyEpoch as number) < 0 || (j.keyEpoch as number) > 4294967295) return null
  return { format: 'slate-quick-unlock', version: 2, ...base, keyEpoch: j.keyEpoch as number }
}

export async function quickUnlockKind(p: QuickUnlockPlatform): Promise<QuickUnlockKind | null> {
  try {
    if (!(await p.secrets.available())) return null
    if (p.platform === 'darwin') return p.systemPreferences.canPromptTouchID?.() && p.systemPreferences.promptTouchID ? 'touchid' : null
    if (p.platform === 'linux') return 'keyring'
  } catch {
    // An unavailable keychain API counts as no quick unlock.
  }
  return null
}

export function quickUnlockEnabled(dataDir: string): boolean {
  return existsSync(join(dataDir, QUICK_UNLOCK_FILE))
}

function aad(f: QuickUnlockFile): Uint8Array {
  if (!('version' in f)) return utf8(`slate-qu/v1|${f.vaultId}|${f.deviceId}`)
  const { nonce: _n, ct: _c, ...bound } = f
  return utf8(`slate-qu/v2|${canonicalJson(bound)}`)
}

/**
 * KEK_qu from the quick-unlock secret, which the module wipes as it derives (a password-class KEK). Suite 0x02:
 * KBKDF(QU, "slate/v2/quick", vid ‖ deviceId bytes), non-approved like every key of a standard vault.
 */
function quickKek(qu: Uint8Array, f: Pick<QuickUnlockFile, 'vaultId' | 'deviceId'> & { version?: 2 }): KeyHandle {
  if (f.version !== 2) return v1QuickKek(qu)
  const context = new Uint8Array(32)
  context.set(vidOf(f.vaultId.toLowerCase()), 0)
  context.set(vidOf(f.deviceId.toLowerCase()), 16)
  return vaultNative().kbkdfFromSecret(qu, 'slate/v2/quick', context, false)
}

/** The ids are the plaintext fields of local-keys.json; a wrong one fails the GCM tag, not a check here. */
async function deviceIds(dataDir: string): Promise<{ vaultId: string; deviceId: string }> {
  const j = (await readJsonCapped(join(dataDir, LOCAL_KEYS_FILE))) as Record<string, unknown>
  if (typeof j.vaultId !== 'string' || !UUID.test(j.vaultId) || typeof j.deviceId !== 'string' || !UUID.test(j.deviceId)) throw new Error('Bad local keys')
  return { vaultId: j.vaultId, deviceId: j.deviceId }
}

/**
 * What vault.json says its version and profile are. Only refusals are taken from it (the header is verified at
 * unlock): a fips-140-3 vault has no quick unlock, and the file's format must be the vault's (review C5 L2: a v1
 * file on a header-v2 vault would run suite 0x01's HKDF for a suite-0x02 vault).
 */
async function vaultShape(dataDir: string): Promise<{ version: unknown; profile: unknown } | null> {
  try {
    const h = (await readJsonCapped(join(dataDir, VAULT_FILE))) as { version?: unknown; profile?: unknown }
    return { version: h.version, profile: h.profile }
  } catch {
    return null
  }
}

/**
 * The caller has just proved the password: `proof` (from `proveSecret`) is its KEK and the header's
 * wrap of MK, which stays the caller's. QU is drawn by the module and exists in JavaScript only as the
 * base64 text the OS keyring seals (Z-12, the standard profile's accepted residual); the module moves MK
 * from the password wrap to KEK_qu (`rewrapKey`), so MK itself is never wrapped anew (review C4 M1).
 * Refused for a fips-140-3 vault (T-POL-06). A suite-0x02 vault writes the v2 file.
 */
export async function enableQuickUnlock(dataDir: string, proof: WrapProof, p: QuickUnlockPlatform, schedule: KeySchedule): Promise<void> {
  if (!PROFILES[schedule.profile].quickUnlock) throw new QuickUnlockNotAllowed()
  if (!(await quickUnlockKind(p))) throw new Error('Quick unlock is not available on this computer')
  const { vaultId, deviceId } = await deviceIds(dataDir)
  const n = vaultNative()
  const qu = n.randomBytes(32)
  let kek: KeyHandle | null = null
  try {
    const sealedQu = toBase64(await p.secrets.seal(toBase64(qu)))
    const head: Omit<QuickUnlockFileV2, 'nonce' | 'ct'> | Omit<QuickUnlockFileV1, 'nonce' | 'ct'> =
      schedule.suite === SUITE.KBKDF_AES256GCM
        ? { format: 'slate-quick-unlock', version: 2, vaultId, deviceId, keyEpoch: epochOf(schedule), sealedQu }
        : { vaultId, deviceId, sealedQu }
    kek = quickKek(qu, head)
    const sealed = n.rewrapKey(proof.kek, proof.iv, proof.aad, proof.ct, kek, aad({ ...head, nonce: '', ct: '' } as QuickUnlockFile))
    const file = { ...head, nonce: toBase64(sealed.subarray(0, 12)), ct: toBase64(sealed.subarray(12)) }
    await writeJsonAtomic(join(dataDir, QUICK_UNLOCK_FILE), file)
  } finally {
    qu.fill(0)
    destroyKey(kek)
  }
}

/**
 * Touch ID (macOS) or the keyring (Linux) → QU → MK, unwrapped straight into the module. Any failure,
 * from a cancelled prompt to a Keychain that refuses a re-signed build, is one QuickUnlockFailed. The
 * caller owns the returned MK, and still verifies it against the vault `check` (unlockVault with `{ mk }`).
 */
export async function openQuickUnlock(dataDir: string, p: QuickUnlockPlatform): Promise<KeyHandle> {
  let qu: Uint8Array | null = null
  let kek: KeyHandle | null = null
  try {
    const kind = await quickUnlockKind(p)
    const vault = await vaultShape(dataDir)
    if (!kind || !vault || vault.profile === 'fips-140-3') throw new QuickUnlockFailed()
    const file = parseQuickUnlock(await readJsonCapped(join(dataDir, QUICK_UNLOCK_FILE)))
    const ids = await deviceIds(dataDir)
    if (!file || file.vaultId !== ids.vaultId || file.deviceId !== ids.deviceId) throw new QuickUnlockFailed()
    // The vault's header picks the format, and so the KDF: suite 0x02 for a header-v2 or v3 vault (the same keys), v1 only for v1.
    if ((vault.version === 2 || vault.version === 3) !== ('version' in file)) throw new QuickUnlockFailed()
    if (kind === 'touchid') await p.systemPreferences.promptTouchID!(TOUCH_ID_REASON)
    // A rotated OS key (`rewrite`) needs no action: the next enable seals QU afresh.
    qu = new Uint8Array(Buffer.from((await p.secrets.open(Buffer.from(file.sealedQu, 'base64'))).plain, 'base64'))
    if (qu.length !== 32) throw new QuickUnlockFailed()
    kek = quickKek(qu, file)
    return vaultNative().gcmOpenKey(kek, Buffer.from(file.nonce, 'base64'), aad(file), Buffer.from(file.ct, 'base64'), 'master')
  } catch (e) {
    if (nativeErrorCode(e) === 'SCC_12') throw e
    throw new QuickUnlockFailed()
  } finally {
    qu?.fill(0)
    destroyKey(kek)
  }
}

/** "Forget quick unlock", and joining another vault (the wrap is bound to this one). */
export async function forgetQuickUnlock(dataDir: string): Promise<void> {
  await rm(join(dataDir, QUICK_UNLOCK_FILE), { force: true })
}
