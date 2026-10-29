// `vault.json`: header v1 (suite 0x01, read and kept as it is until C9), header v2 (audit §4.5.2: a
// profile, suite 0x02, a key epoch and explicit algorithm identifiers) and header v3 (v2 plus `pq` and hybrid
// device slots, docs/reviews/quantum-proof-roadmap.md §3.2), each authenticated by `check` once MK is known.
// Every vault created since C5 is v2; v3 is made from v2 by `buildHeaderV3From` with the same keys.
import { newId } from '@slate/core'
import { LOCAL_JSON_CAP } from './atomic'
import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { decodeB64, defaultKdf, deriveKek, kdfForProfile, validateKdf, type Argon2idParams, type KdfParams, type WeakKdfOption } from './kdf'
import { deriveSubkey } from './keyring'
import { destroyKey, equalBytes, toBase64, utf8, vaultNative } from './native'
import { checkProfileUsable, isProfileId, profileRank, type ProfileId } from './profile'
import { BadRecoveryKey, decodeRecovery, encodeRecovery } from './recovery'
import type { VaultSecret } from '../../shared/api'
import type { SecretBytes } from '../../shared/secret'
import { SCHEDULE_V1, SUITE, scheduleV2, vidOf, type KeySchedule } from './suite'
import { v1RecoveryKek, v1RecoveryKekFromHandle } from './suite1'

export type Slot = 'password' | 'recovery'

export interface Wrap {
  nonce: string
  ct: string
}

/** A v2 wrap names its AEAD, so another one can follow without a format change (audit §3.7). */
export interface WrapV2 extends Wrap {
  alg: 'aes-256-gcm'
}

/** MK of an earlier key epoch, wrapped under K_hist (C9 writes these; C5 parses them). */
export interface HistoryEntry extends WrapV2 {
  epoch: number
}

/** `vault.json` v1 (§4): non-secret, authenticated by `check` once MK is known. */
export interface VaultHeaderV1 {
  format: 'slate-vault'
  version: 1
  vaultId: string
  revision: number
  createdAt: number
  kdf: Argon2idParams
  wraps: { password: Wrap; recovery?: Wrap }
  check: string
}

/** `vault.json` v2 (audit §4.5.2, docs/compliance/schemas/vault-header-v2.schema.json). */
export interface VaultHeaderV2 {
  format: 'slate-vault'
  version: 2
  vaultId: string
  revision: number
  createdAt: number
  profile: ProfileId
  suite: typeof SUITE.KBKDF_AES256GCM
  keyEpoch: number
  kdf: KdfParams
  wraps: { password: WrapV2; recovery?: WrapV2 }
  history?: HistoryEntry[]
  check: string
}

/** A hybrid ML-KEM device slot (roadmap §3.2): parsed and carried through unchanged; this build never opens one. */
export type DeviceWrapAlg = 'mlkem768-x25519-kdf56c' | 'mlkem1024-p384-kdf56c'
export type DeviceSlotName = `device-${string}`

export interface DeviceWrap {
  alg: DeviceWrapAlg
  pkHash: string
  kemCt: string
  ecdhPub: string
  nonce: string
  ct: string
  addedAt: number
  addedBy: string
}

/** `vault.json` v3 (docs/compliance/schemas/vault-header-v3.schema.json): v2's keys and wraps, plus `pq`. */
export interface VaultHeaderV3 extends Omit<VaultHeaderV2, 'version' | 'wraps'> {
  version: 3
  wraps: { password: WrapV2; recovery?: WrapV2; [slot: DeviceSlotName]: DeviceWrap }
  pq: { kem: 'hybrid-only'; minCapability: number }
}

export type VaultHeader = VaultHeaderV1 | VaultHeaderV2 | VaultHeaderV3

export class BadHeader extends Error {
  override name = 'BadHeader'
}

/** One error for a wrong secret and for a header that fails `check`, so the two are indistinguishable. */
export class WrongSecret extends Error {
  override name = 'WrongSecret'
  constructor() {
    super('That password or recovery key is not correct')
  }
}

/** Header v1 is always the standard profile. */
export function profileOf(header: VaultHeader): ProfileId {
  return header.version === 1 ? 'standard' : header.profile
}

export function scheduleOf(header: Pick<VaultHeader, 'version' | 'vaultId'> & { profile?: ProfileId; keyEpoch?: number }): KeySchedule {
  return header.version === 1 ? SCHEDULE_V1 : scheduleV2(header.vaultId, header.profile ?? 'standard', header.keyEpoch ?? 0)
}

/**
 * A header for this vault that ranks lower than `than` (an older format or a weaker profile): a device never
 * adopts one, exactly as it never adopts a lower revision (audit §4.5.2 downgrade protection).
 */
export function isDowngrade(
  header: Pick<VaultHeader, 'version'> & { profile?: ProfileId; keyEpoch?: number },
  than: { version: number; profile: ProfileId; keyEpoch?: number },
): boolean {
  const profile = header.version >= 2 && header.profile ? header.profile : 'standard'
  // Review C9 L2: an earlier key epoch is a downgrade too (a retired master key re-signing its header at a higher
  // revision); the floor is the epoch of this device's own header, the highest it adopted.
  const epochBack = header.version >= 2 && than.keyEpoch !== undefined && (header.keyEpoch ?? 0) < than.keyEpoch
  return header.version < than.version || profileRank(profile) < profileRank(than.profile) || epochBack
}

/** The downgrade floor a header sets: its version, profile and key epoch. */
export function floorOf(header: VaultHeader): { version: number; profile: ProfileId; keyEpoch: number } {
  return { version: header.version, profile: profileOf(header), keyEpoch: header.version === 1 ? 0 : header.keyEpoch }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/**
 * RFC 8785 for the values a header holds: integers only (no float formatting needed), keys sorted
 * by UTF-16 code units (JavaScript's default string order), strings escaped as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonicalJson: only safe integers')
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
  }
  throw new Error(`canonicalJson: cannot encode ${typeof value}`)
}
export type { Json }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MK_BYTES = 32
const U32_MAX = 4294967295

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function exactKeys(v: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isObject(v)) throw new BadHeader('Expected an object')
  for (const k of required) if (!Object.hasOwn(v, k)) throw new BadHeader(`Missing ${k}`)
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) throw new BadHeader(`Unexpected ${k}`)
  return v
}

function b64(v: unknown, len: number, what: string): string {
  const b = decodeB64(v)
  if (!b || b.length !== len) throw new BadHeader(`Bad ${what}`)
  return v as string
}

function intIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new BadHeader(`Bad ${what}`)
  return v
}

function parseWrap(v: unknown, slot: string): Wrap {
  const w = exactKeys(v, ['nonce', 'ct'])
  return { nonce: b64(w.nonce, 12, `${slot} nonce`), ct: b64(w.ct, MK_BYTES + 16, `${slot} wrap`) }
}

function kdfError(kdf: KdfParams, opts: WeakKdfOption): void {
  try {
    validateKdf(kdf, opts)
  } catch (e) {
    throw new BadHeader((e as Error).message)
  }
}

/** The strict schema of §4, run before anything is derived from a header of any origin. */
function parseHeaderV1(json: unknown, opts: WeakKdfOption): VaultHeaderV1 {
  const h = exactKeys(json, ['format', 'version', 'vaultId', 'revision', 'createdAt', 'kdf', 'wraps', 'check'])
  if (h.format !== 'slate-vault' || h.version !== 1) throw new BadHeader('Not a Slate vault header')
  if (typeof h.vaultId !== 'string' || !UUID.test(h.vaultId)) throw new BadHeader('Bad vaultId')
  if (!Number.isSafeInteger(h.revision) || (h.revision as number) < 1) throw new BadHeader('Bad revision')
  if (!Number.isSafeInteger(h.createdAt) || (h.createdAt as number) < 0) throw new BadHeader('Bad createdAt')
  const k = exactKeys(h.kdf, ['alg', 'memoryKiB', 'passes', 'parallelism', 'salt'])
  if (k.alg !== 'argon2id') throw new BadHeader('Unsupported key derivation')
  const kdf = { alg: k.alg, memoryKiB: k.memoryKiB, passes: k.passes, parallelism: k.parallelism, salt: k.salt } as Argon2idParams
  kdfError(kdf, opts)
  const w = exactKeys(h.wraps, ['password'], ['recovery'])
  const wraps: VaultHeaderV1['wraps'] = { password: parseWrap(w.password, 'password') }
  if (w.recovery !== undefined) wraps.recovery = parseWrap(w.recovery, 'recovery')
  return {
    format: 'slate-vault',
    version: 1,
    vaultId: h.vaultId,
    revision: h.revision as number,
    createdAt: h.createdAt as number,
    kdf,
    wraps,
    check: b64(h.check, 32, 'check'),
  }
}

// The schema's patterns (docs/compliance/schemas/vault-header-v2.schema.json), byte for byte: a 12-byte nonce
// and a 48-byte wrap are whole base64 groups, and `check` is the canonical encoding of 32 bytes.
const NONCE_B64 = /^[A-Za-z0-9+/]{16}$/
const CT_B64 = /^[A-Za-z0-9+/]{64}$/
const CHECK_B64 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/
const SALT_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function str(v: unknown, re: RegExp, what: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw new BadHeader(`Bad ${what}`)
  return v
}

function parseWrapV2(v: unknown, what: string): WrapV2 {
  const w = exactKeys(v, ['alg', 'nonce', 'ct'])
  if (w.alg !== 'aes-256-gcm') throw new BadHeader(`Unsupported ${what} algorithm`)
  return { alg: 'aes-256-gcm', nonce: str(w.nonce, NONCE_B64, `${what} nonce`), ct: str(w.ct, CT_B64, `${what} wrap`) }
}

/** Semantic rule 1: a salt is canonical base64 of 16–64 bytes (the schema bounds only its text). */
function parseSalt(v: unknown): string {
  if (typeof v !== 'string' || v.length < 24 || v.length > 88 || !SALT_B64.test(v)) throw new BadHeader('Bad salt')
  const b = decodeB64(v)
  if (!b || b.length < 16 || b.length > 64) throw new BadHeader('Bad salt')
  return v
}

function parseKdfV2(v: unknown, opts: WeakKdfOption): KdfParams {
  if (!isObject(v)) throw new BadHeader('Expected an object')
  // The weak test floors exist only for unit tests (allowWeakForTests); the schema's own floors apply otherwise.
  const weak = opts.allowWeakForTests === true
  if (v.alg === 'argon2id') {
    const k = exactKeys(v, ['alg', 'memoryKiB', 'passes', 'parallelism', 'salt'])
    const kdf: Argon2idParams = {
      alg: 'argon2id',
      memoryKiB: intIn(k.memoryKiB, weak ? 32 : 65536, 1048576, 'memoryKiB'),
      passes: intIn(k.passes, weak ? 1 : 2, 10, 'passes'),
      parallelism: intIn(k.parallelism, 1, 1, 'parallelism'),
      salt: parseSalt(k.salt),
    }
    kdfError(kdf, opts)
    return kdf
  }
  if (v.alg === 'pbkdf2-hmac-sha512') {
    const k = exactKeys(v, ['alg', 'iterations', 'salt'])
    const kdf: KdfParams = { alg: 'pbkdf2-hmac-sha512', iterations: intIn(k.iterations, weak ? 1000 : 600000, 10000000, 'iterations'), salt: parseSalt(k.salt) }
    kdfError(kdf, opts)
    return kdf
  }
  throw new BadHeader('Unsupported key derivation')
}

const V2_KEYS = ['format', 'version', 'vaultId', 'revision', 'createdAt', 'profile', 'suite', 'keyEpoch', 'kdf', 'wraps', 'check']

/**
 * Header v2: exactly the documents the JSON Schema accepts (docs/compliance/schemas/vault-header-v2.schema.json)
 * that also keep semantic rules 1–3 of audit §4.5.2; rule 4 (the 64 KiB cap) is the reader's (`readJsonCapped`).
 * Every refusal is a BadHeader, before any derivation. What it returns is the input, field for field.
 */
export function parseHeaderV2(json: unknown, opts: WeakKdfOption = {}): VaultHeaderV2 {
  const h = exactKeys(json, V2_KEYS, ['history'])
  if (h.format !== 'slate-vault' || h.version !== 2) throw new BadHeader('Not a Slate vault header')
  const { wraps: _w, ...fields } = parseV2Fields(h, opts)
  const w = exactKeys(h.wraps, ['password'], ['recovery'])
  const wraps: VaultHeaderV2['wraps'] = { password: parseWrapV2(w.password, 'password') }
  if (w.recovery !== undefined) wraps.recovery = parseWrapV2(w.recovery, 'recovery')
  return { ...fields, version: 2, wraps }
}

/** Every field v2 and v3 share, with rules 1–3; the caller has checked the keys, `format` and `version`. */
function parseV2Fields(h: Record<string, unknown>, opts: WeakKdfOption): Omit<VaultHeaderV2, 'version'> {
  if (typeof h.vaultId !== 'string' || !UUID4.test(h.vaultId)) throw new BadHeader('Bad vaultId')
  const revision = intIn(h.revision, 1, Number.MAX_SAFE_INTEGER, 'revision')
  const createdAt = intIn(h.createdAt, 0, Number.MAX_SAFE_INTEGER, 'createdAt')
  if (!isProfileId(h.profile)) throw new BadHeader('Unknown profile')
  // The suite registry: only 0x02 is a header-v2 suite (0x03-0x1F reserved, refused).
  if (h.suite !== SUITE.KBKDF_AES256GCM) throw new BadHeader('Unknown cipher suite')
  const keyEpoch = intIn(h.keyEpoch, 0, U32_MAX, 'keyEpoch')
  const kdf = parseKdfV2(h.kdf, opts)
  // Rule 2: the profile fixes the password KDF.
  if ((h.profile === 'fips-140-3') !== (kdf.alg === 'pbkdf2-hmac-sha512')) throw new BadHeader('The key derivation does not match the profile')
  const out: Omit<VaultHeaderV2, 'version'> = {
    format: 'slate-vault',
    vaultId: h.vaultId,
    revision,
    createdAt,
    profile: h.profile,
    suite: SUITE.KBKDF_AES256GCM,
    keyEpoch,
    kdf,
    wraps: { password: { alg: 'aes-256-gcm', nonce: '', ct: '' } },
    check: '',
  }
  if (h.history !== undefined) {
    if (!Array.isArray(h.history) || h.history.length > 4) throw new BadHeader('Bad history')
    const seen = new Set<number>()
    out.history = h.history.map((e: unknown) => {
      const x = exactKeys(e, ['epoch', 'alg', 'nonce', 'ct'])
      const epoch = intIn(x.epoch, 0, U32_MAX - 1, 'history epoch')
      // Rule 3: distinct epochs, all before the current one.
      if (seen.has(epoch) || epoch >= keyEpoch) throw new BadHeader('Bad history epoch')
      seen.add(epoch)
      const wrap = parseWrapV2({ alg: x.alg, nonce: x.nonce, ct: x.ct }, 'history')
      return { epoch, ...wrap }
    })
  }
  out.check = str(h.check, CHECK_B64, 'check')
  return out
}

// docs/compliance/schemas/vault-header-v3.schema.json, byte for byte.
const DEVICE_SLOT = /^device-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const B64 = SALT_B64
const MAX_WRAPS = 18
/** §3.2's size budget: 16 device slots at most, whatever else `wraps` holds (the schema counts only all wraps). */
const MAX_DEVICE_SLOTS = 16
/** Rule 7: the exact decoded sizes of each hybrid slot's ML-KEM ciphertext and ECDH public key. A Map, so no
 * inherited name (`constructor`, `__proto__`) is ever an algorithm. */
const DEVICE_ALGS = new Map<string, { kemCt: number; ecdhPub: number; uncompressedPoint: boolean }>([
  ['mlkem768-x25519-kdf56c', { kemCt: 1088, ecdhPub: 32, uncompressedPoint: false }],
  ['mlkem1024-p384-kdf56c', { kemCt: 1568, ecdhPub: 97, uncompressedPoint: true }],
])

/** Schema text bounds, then rule 7's exact size; canonical base64 only, so a carried slot has one text. */
function b64Sized(v: unknown, minLen: number, maxLen: number, bytes: number, what: string): Buffer {
  if (typeof v !== 'string' || v.length < minLen || v.length > maxLen || !B64.test(v)) throw new BadHeader(`Bad ${what}`)
  const b = decodeB64(v)
  if (!b || b.length !== bytes) throw new BadHeader(`Bad ${what}`)
  return b
}

function parseDeviceWrap(v: unknown, profile: ProfileId): DeviceWrap {
  const w = exactKeys(v, ['alg', 'pkHash', 'kemCt', 'ecdhPub', 'nonce', 'ct', 'addedAt', 'addedBy'])
  // INV-PQ-1: only hybrid identifiers with an ML-KEM component.
  const size = typeof w.alg === 'string' ? DEVICE_ALGS.get(w.alg) : undefined
  if (!size) throw new BadHeader('Unsupported device slot algorithm')
  const alg = w.alg as DeviceWrapAlg
  // Rule 8: a fips-140-3 vault holds only the CNSA 2.0 pairing.
  if (profile === 'fips-140-3' && alg !== 'mlkem1024-p384-kdf56c') throw new BadHeader('Device slot algorithm not allowed in this profile')
  const pkHash = str(w.pkHash, CHECK_B64, 'device slot pkHash')
  b64Sized(w.kemCt, 1452, 2092, size.kemCt, 'device slot kemCt')
  const pub = b64Sized(w.ecdhPub, 44, 132, size.ecdhPub, 'device slot ecdhPub')
  if (size.uncompressedPoint && pub[0] !== 0x04) throw new BadHeader('Bad device slot ecdhPub')
  return {
    alg,
    pkHash,
    kemCt: w.kemCt as string,
    ecdhPub: w.ecdhPub as string,
    nonce: str(w.nonce, NONCE_B64, 'device slot nonce'),
    ct: str(w.ct, CT_B64, 'device slot wrap'),
    addedAt: intIn(w.addedAt, 0, Number.MAX_SAFE_INTEGER, 'device slot addedAt'),
    addedBy: str(w.addedBy, UUID4, 'device slot addedBy'),
  }
}

/** Rule 4 restated for a header that did not come through `readJsonCapped` (a remote snapshot, a test). */
function withinCap(json: unknown): void {
  let text: string | undefined
  try {
    text = JSON.stringify(json)
  } catch {
    throw new BadHeader('Not JSON')
  }
  if (typeof text !== 'string' || Buffer.byteLength(text) > LOCAL_JSON_CAP) throw new BadHeader('The header is larger than 64 KiB')
}

/**
 * Header v3: exactly the documents docs/compliance/schemas/vault-header-v3.schema.json accepts that also keep
 * rules 1–8 of roadmap §3.3. Every refusal is a BadHeader, before any derivation and without a native call.
 * What it returns is the input, field for field, device slots included (rule 10 carries them through).
 */
export function parseHeaderV3(json: unknown, opts: WeakKdfOption = {}): VaultHeaderV3 {
  withinCap(json)
  const h = exactKeys(json, [...V2_KEYS, 'pq'], ['history'])
  if (h.format !== 'slate-vault' || h.version !== 3) throw new BadHeader('Not a Slate vault header')
  const { wraps: _w, ...fields } = parseV2Fields(h, opts)
  const w = exactKeys(h.wraps, ['password'], Object.keys(isObject(h.wraps) ? h.wraps : {}))
  const keys = Object.keys(w)
  if (keys.length > MAX_WRAPS) throw new BadHeader('Too many wraps')
  const wraps: VaultHeaderV3['wraps'] = { password: parseWrapV2(w.password, 'password') }
  let devices = 0
  for (const k of keys) {
    if (k === 'password') continue
    if (k === 'recovery') wraps.recovery = parseWrapV2(w.recovery, 'recovery')
    else if (DEVICE_SLOT.test(k)) {
      wraps[k as DeviceSlotName] = parseDeviceWrap(w[k], fields.profile)
      devices++
    } else throw new BadHeader(`Unexpected ${k}`)
  }
  if (devices > MAX_DEVICE_SLOTS) throw new BadHeader('Too many device slots')
  const pq = exactKeys(h.pq, ['kem', 'minCapability'])
  // Rule 5: restated here so a later schema cannot relax it silently.
  if (pq.kem !== 'hybrid-only') throw new BadHeader('Unsupported pq.kem')
  const minCapability = intIn(pq.minCapability, 1, 255, 'pq.minCapability')
  // Rule 6: a device slot is readable only by a device of capability 2.
  if (devices > 0 && minCapability < 2) throw new BadHeader('Device slots need pq.minCapability 2')
  return { ...fields, version: 3, wraps, pq: { kem: 'hybrid-only', minCapability } }
}

/** Header v1, v2 or v3, by its `version`, before any derivation; anything else is a BadHeader. */
export function parseHeader(json: unknown, opts: WeakKdfOption = {}): VaultHeader {
  if (isObject(json) && json.version === 3) return parseHeaderV3(json, opts)
  if (isObject(json) && json.version === 2) return parseHeaderV2(json, opts)
  return parseHeaderV1(json, opts)
}

type AadFields =
  | Pick<VaultHeaderV1, 'version' | 'vaultId' | 'kdf'>
  | Pick<VaultHeaderV2, 'version' | 'vaultId' | 'kdf' | 'profile' | 'keyEpoch'>
  | Pick<VaultHeaderV3, 'version' | 'vaultId' | 'kdf' | 'profile' | 'keyEpoch'>

/**
 * v2 (audit §4.5.2): the slot, profile, suite, key epoch and KDF are all bound, so none can be swapped. A v3 header's
 * password and recovery wraps use this AAD byte for byte (roadmap §3.3 rule 9): the label names the wrap format, not
 * the header version, which is why v2 → v3 copies the wraps and needs neither secret.
 */
function wrapAad(header: AadFields, slot: Slot): Uint8Array {
  if (header.version === 1) return utf8(`slate-vault/v1|${header.vaultId}|${slot}|${canonicalJson(header.kdf)}`)
  const epoch = header.keyEpoch
  return utf8(`slate-vault/v2|${header.vaultId}|${slot}|${header.profile}|${SUITE.KBKDF_AES256GCM}|${epoch}|${canonicalJson(header.kdf)}`)
}

type HeaderBody = Omit<VaultHeaderV1, 'check'> | Omit<VaultHeaderV2, 'check'> | Omit<VaultHeaderV3, 'check'>

function computeCheck(header: HeaderBody, mk: KeyHandle): Uint8Array {
  const { check: _drop, ...rest } = header as VaultHeader
  const kCheck = deriveSubkey(mk, 'check', scheduleOf(header))
  try {
    return vaultNative().hmacSha256(kCheck, utf8(canonicalJson(rest)))
  } finally {
    destroyKey(kCheck)
  }
}

export function verifyCheck(header: VaultHeader, mk: KeyHandle): boolean {
  return equalBytes(Buffer.from(header.check, 'base64'), computeCheck(header, mk))
}

function toWrap(header: Pick<VaultHeader, 'version'>, sealed: Uint8Array): Wrap | WrapV2 {
  const w = { nonce: toBase64(sealed.subarray(0, 12)), ct: toBase64(sealed.subarray(12)) }
  return header.version === 1 ? w : { alg: 'aes-256-gcm', ...w }
}

/** A fresh MK (createVault) wrapped under a password-class KEK; neither key leaves the module. */
function seal(kek: KeyHandle, mk: KeyHandle, header: HeaderBody, slot: Slot): WrapV2 {
  return toWrap(header, vaultNative().gcmSealKey(kek, mk, null, wrapAad(header, slot))) as WrapV2
}

/**
 * KEK_rc from a new recovery secret, which exists as JavaScript bytes only while it is made and shown to
 * the user once (sealRecovery, newRecoveryKey). The module wipes `secret` as it derives; the caller destroys
 * the returned KEK. A typed recovery key never comes this way: it is decoded inside the module
 * (`recoveryKekFromText`, C7). Suite 0x02: KBKDF(RK, "slate/v2/recovery", vid), approved only in the
 * fips-140-3 profile (a standard MK is also opened by an Argon2id KEK, IG 2.4.A).
 */
function recoveryKek(secret: Uint8Array, header: Pick<VaultHeader, 'version' | 'vaultId'> & { profile?: ProfileId }): KeyHandle {
  if (header.version === 1) return v1RecoveryKek(secret, header.vaultId)
  return vaultNative().kbkdfFromSecret(secret, 'slate/v2/recovery', vidOf(header.vaultId), header.profile === 'fips-140-3')
}

function finish<T extends HeaderBody>(body: T, mk: KeyHandle): T & { check: string } {
  return { ...body, check: toBase64(computeCheck(body, mk)) }
}

/**
 * Unwrap then check, with the same work either way: a failed unwrap still computes `check` under a
 * random master key, so a bad wrap and a bad check take the same path and throw the same error. MK is
 * unwrapped straight into the module (criterion 4). Returns MK, which the caller owns and destroys;
 * `kek` stays the caller's. Anything that does not verify is destroyed here.
 */
function open(header: VaultHeader, slot: Slot, kek: KeyHandle): KeyHandle {
  const n = vaultNative()
  const wrap = header.wraps[slot]
  let mk: KeyHandle | null = null
  if (wrap) {
    try {
      mk = n.gcmOpenKey(kek, Buffer.from(wrap.nonce, 'base64'), wrapAad(header, slot), Buffer.from(wrap.ct, 'base64'), 'master')
    } catch (e) {
      // The module's error state is not a wrong password (F-FIPS-05): it must reach the caller as itself.
      if (nativeErrorCode(e) === 'SCC_12') throw e
      mk = null
    }
  }
  const candidate = mk ?? n.keyRandom('master')
  let ok = false
  try {
    ok = verifyCheck(header, candidate) && candidate === mk
  } finally {
    if (!ok) destroyKey(candidate)
  }
  if (!ok || mk === null) throw new WrongSecret()
  return mk
}

export interface CreateVaultInput {
  password: SecretBytes
  recovery?: boolean
  /** The crypto profile (audit §4.1); `standard` when not given. */
  profile?: ProfileId
  /**
   * A complete KDF for the profile, or just an Argon2id cost for a standard vault (tests and fixed-cost
   * callers); otherwise the profile's calibrated default.
   */
  kdf?: KdfParams | Pick<Argon2idParams, 'memoryKiB' | 'passes'>
  /** 3 when the upgrade gate allows it (PQ-B4: every device reads v3, or sync was never used); 2 otherwise. */
  headerVersion?: 2 | 3
}

/** The `pq` member of every v3 header this build writes itself: no device slots, so capability 1. */
const PQ_V3 = { kem: 'hybrid-only', minCapability: 1 } as const

/**
 * A new header-v2 or header-v3 vault (criterion 3; roadmap §3.5 `Created`), in memory: for fips-140-3 the module must be in approved mode. Nothing
 * is latched here (the wizard may still be cancelled); the caller latches when it commits the vault
 * (`latchProfile`, review C5 M1). Only approved services run before that. Returns MK, which the caller owns.
 * Every KEK is destroyed and the recovery secret wiped here.
 */
export async function createVault(input: CreateVaultInput & { headerVersion?: 2 }, opts?: WeakKdfOption): Promise<{ header: VaultHeaderV2; mk: KeyHandle; recoveryKey: string | null }>
export async function createVault(input: CreateVaultInput, opts?: WeakKdfOption): Promise<{ header: VaultHeaderV2 | VaultHeaderV3; mk: KeyHandle; recoveryKey: string | null }>
export async function createVault(input: CreateVaultInput, opts: WeakKdfOption = {}): Promise<{ header: VaultHeaderV2 | VaultHeaderV3; mk: KeyHandle; recoveryKey: string | null }> {
  const profile = input.profile ?? 'standard'
  checkProfileUsable(profile)
  const kdf: KdfParams = input.kdf === undefined ? await kdfForProfile(profile) : 'alg' in input.kdf ? input.kdf : { ...defaultKdf(), ...input.kdf }
  if ((profile === 'fips-140-3') !== (kdf.alg === 'pbkdf2-hmac-sha512')) throw new Error(`A ${profile} vault cannot use ${kdf.alg}`)
  const vaultId = newId()
  const kek = await deriveKek(input.password, kdf, opts)
  let mk: KeyHandle | null = null
  try {
    mk = vaultNative().keyRandom('master')
    const body: Omit<VaultHeaderV2, 'check'> = {
      format: 'slate-vault',
      version: 2,
      vaultId,
      revision: 1,
      createdAt: Date.now(),
      profile,
      suite: SUITE.KBKDF_AES256GCM,
      keyEpoch: 0,
      kdf,
      wraps: { password: { alg: 'aes-256-gcm', nonce: '', ct: '' } },
    }
    body.wraps.password = seal(kek, mk, body, 'password')
    let recoveryKey: string | null = null
    if (input.recovery !== false) {
      const sealed = sealRecovery(mk, body)
      recoveryKey = sealed.recoveryKey
      body.wraps.recovery = sealed.wrap
    }
    // The wraps' AAD is the same for v2 and v3 (rule 9), so v3 is v2's body plus `pq`.
    const header = input.headerVersion === 3 ? finish({ ...body, version: 3 as const, pq: { ...PQ_V3 } }, mk) : finish(body, mk)
    return { header, mk, recoveryKey }
  } catch (e) {
    destroyKey(mk)
    throw e
  } finally {
    destroyKey(kek)
  }
}

/**
 * A new recovery secret and its wrap of a fresh MK. The secret exists as JavaScript bytes only long enough to
 * become the text the user saves (an inherent residual, like the typed password), then the module wipes it.
 */
function sealRecovery(mk: KeyHandle, body: Omit<VaultHeaderV2, 'check'>): { wrap: WrapV2; recoveryKey: string } {
  const secret = vaultNative().randomBytes(32)
  let kek: KeyHandle | null = null
  try {
    const recoveryKey = encodeRecovery(secret)
    kek = recoveryKek(secret, body)
    return { wrap: seal(kek, mk, body, 'recovery'), recoveryKey }
  } finally {
    secret.fill(0)
    destroyKey(kek)
  }
}

/** Returns MK, which the caller owns and destroys; KEK_pw is destroyed here. */
export async function unlockWithPassword(header: VaultHeader, password: SecretBytes, opts: WeakKdfOption = {}): Promise<KeyHandle> {
  const kek = await deriveKek(password, header.kdf, opts)
  try {
    return open(header, 'password', kek)
  } finally {
    destroyKey(kek)
  }
}

/**
 * Returns MK, which the caller owns and destroys. The typed recovery key is decoded inside the module
 * (`decodeRecovery`, C7) and KEK_rc derived from the handle; KEK_rc is destroyed here. A key that does
 * not decode takes the same path with a random KEK, so it fails like a wrong one.
 */
export function unlockWithRecovery(header: VaultHeader, recoveryKey: SecretBytes): KeyHandle {
  const kek = recoveryKekFromText(header, recoveryKey)
  try {
    return open(header, 'recovery', kek)
  } finally {
    destroyKey(kek)
  }
}

/** KEK_rc from the typed recovery key; one that does not decode gives a random KEK, so it fails like a wrong one. */
function recoveryKekFromText(header: VaultHeader, recoveryKey: SecretBytes): KeyHandle {
  let decoded: KeyHandle
  try {
    decoded = decodeRecovery(recoveryKey)
  } catch (e) {
    if (!(e instanceof BadRecoveryKey)) throw e
    return recoveryKek(vaultNative().randomBytes(32), header)
  }
  try {
    if (header.version === 1) return v1RecoveryKekFromHandle(decoded, header.vaultId)
    return vaultNative().kbkdfFromRecovery(decoded, 'slate/v2/recovery', vidOf(header.vaultId), header.profile === 'fips-140-3')
  } finally {
    destroyKey(decoded)
  }
}

/**
 * Proof that the caller holds one of the vault's secrets: the KEK it gives and the wrap of MK that KEK
 * opens. Since review C4 M1 the module wraps only a fresh key, so a header change moves this wrap to the
 * new secret's KEK (`rewrapKey`) instead: MK leaves a wrap only for a caller who opened one.
 */
export interface WrapProof {
  readonly kek: KeyHandle
  readonly iv: Uint8Array
  readonly aad: Uint8Array
  readonly ct: Uint8Array
}

/** The caller owns the proof's KEK and destroys it with `destroyProof`. Throws WrongSecret if the secret does not open `header`. */
export async function proveSecret(header: VaultHeader, secret: VaultSecret, opts: WeakKdfOption = {}): Promise<WrapProof> {
  const slot: Slot = 'password' in secret ? 'password' : 'recovery'
  const kek = 'password' in secret ? await deriveKek(secret.password, header.kdf, opts) : recoveryKekFromText(header, secret.recoveryKey)
  try {
    destroyKey(open(header, slot, kek))
  } catch (e) {
    destroyKey(kek)
    throw e
  }
  const wrap = header.wraps[slot]
  if (!wrap) {
    destroyKey(kek)
    throw new WrongSecret()
  }
  return { kek, iv: Buffer.from(wrap.nonce, 'base64'), aad: wrapAad(header, slot), ct: Buffer.from(wrap.ct, 'base64') }
}

export function destroyProof(proof: WrapProof | null | undefined): void {
  destroyKey(proof?.kek)
}

/** MK moved from the proof's wrap to `kek`, inside the module. */
function rewrap(proof: WrapProof, kek: KeyHandle, body: HeaderBody, slot: Slot): Wrap {
  return toWrap(body, vaultNative().rewrapKey(proof.kek, proof.iv, proof.aad, proof.ct, kek, wrapAad(body, slot)))
}

function next(base: VaultHeader, mk: KeyHandle): HeaderBody {
  if (!verifyCheck(base, mk)) throw new WrongSecret()
  const { check: _drop, ...rest } = structuredClone(base)
  return { ...rest, revision: base.revision + 1 }
}

/**
 * Header v3 from a v2 header `mk` verifies (roadmap §3.4): the same keys, every wrap copied as it is (rule 9), `pq`
 * set, the next revision, `check` under K_check of `mk`. Pure: nothing is written, and neither secret is needed.
 */
export function buildHeaderV3From(v2: VaultHeaderV2, mk: KeyHandle): VaultHeaderV3 {
  const body = next(v2, mk) as Omit<VaultHeaderV2, 'check'>
  return finish({ ...body, version: 3, pq: { ...PQ_V3 } }, mk)
}

/**
 * Keeps the KDF salt and parameters: they are in every slot's AAD, and the recovery slot cannot
 * be rewrapped without the recovery key. A new password under the same salt still gives a new KEK.
 * `proof` (from `proveSecret` with the current password or recovery key) is where MK comes from.
 */
export async function changePassword<H extends VaultHeader>(base: H, mk: KeyHandle, proof: WrapProof, newPw: SecretBytes, opts: WeakKdfOption = {}): Promise<H> {
  const body = next(base, mk)
  const kek = await deriveKek(newPw, body.kdf, opts)
  try {
    ;(body.wraps as { password: Wrap }).password = rewrap(proof, kek, body, 'password')
  } finally {
    destroyKey(kek)
  }
  return finish(body, mk) as H
}

/** A new recovery secret, shown once; MK moves to it from `proof`'s wrap. The secret and KEK_rc are wiped here. */
export function newRecoveryKey<H extends VaultHeader>(base: H, mk: KeyHandle, proof: WrapProof): { header: H; recoveryKey: string } {
  const body = next(base, mk)
  const secret = vaultNative().randomBytes(32)
  let kek: KeyHandle | null = null
  try {
    const recoveryKey = encodeRecovery(secret)
    kek = recoveryKek(secret, body)
    ;(body.wraps as { recovery?: Wrap }).recovery = rewrap(proof, kek, body, 'recovery')
    return { header: finish(body, mk) as H, recoveryKey }
  } finally {
    secret.fill(0)
    destroyKey(kek)
  }
}

/**
 * §15 N2: every change builds on the highest-revision header this device can verify. A pending header of an
 * older format or a weaker profile than the local one is never a candidate (audit §4.5.2).
 */
export function chooseBase(local: VaultHeader, pending: VaultHeader | null | undefined, mk: KeyHandle): VaultHeader {
  const floor = floorOf(local)
  const ok = [local, pending].filter(
    (h): h is VaultHeader => !!h && h.vaultId === local.vaultId && !isDowngrade(h, floor) && verifyCheck(h, mk),
  )
  if (ok.length === 0) throw new WrongSecret()
  return ok.reduce((a, b) => (b.revision > a.revision ? b : a))
}

/**
 * Whether two master-key handles hold the same key, without either leaving the module: the same
 * `check` subkey gives the same MAC over a fresh random message. Constant time over the MACs.
 */
export function sameMasterKey(a: KeyHandle, b: KeyHandle, schedule: KeySchedule): boolean {
  const n = vaultNative()
  const probe = n.randomBytes(32)
  const ka = deriveSubkey(a, 'check', schedule)
  try {
    const kb = deriveSubkey(b, 'check', schedule)
    try {
      return equalBytes(n.hmacSha256(ka, probe), n.hmacSha256(kb, probe))
    } finally {
      destroyKey(kb)
    }
  } finally {
    destroyKey(ka)
  }
}

// ---- C9: key epochs (audit §4.5.2 `history`, §4.7 R-1 … R-5) ----

/** R-4: MK's originator-usage period, 2 years (SP 800-57 Pt 1 r5, Table 1). */
export const CRYPTOPERIOD_MS = 730 * 24 * 60 * 60 * 1000

/**
 * R-4: when a fips-140-3 vault's keys fell due for rotation (`createdAt`, the current MK's making, plus the
 * cryptoperiod), or null when they are not due or the profile sets no cryptoperiod. Nothing rotates by itself.
 */
export function rotationDueSince(header: VaultHeader, now = Date.now()): number | null {
  if (profileOf(header) !== 'fips-140-3') return null
  const due = header.createdAt + CRYPTOPERIOD_MS
  return now >= due ? due : null
}

/** A rotation the vault cannot make as it is (history full, a profile move that is not R-3, an epoch overflow). */
export class RotationRefused extends Error {
  override name = 'RotationRefused'
}

/** R-1: `history` keeps at most four earlier epochs; a fifth rotation waits until the oldest is pruned (R-2). */
export const MAX_HISTORY = 4

/**
 * What a rekey does: `rotate` (R-1, a new epoch), `upgrade` (R-5, a header-v1 vault to v2 or v3 by a rotation, same
 * profile), `convert` (R-3, standard to fips-140-3: a rotation that empties `history`).
 */
export type RekeyKind = 'rotate' | 'upgrade' | 'convert'

export interface RekeyInput {
  kind: RekeyKind
  /** The header the change builds on, verified under `mk` (§15 N2). */
  base: VaultHeader
  /** The ring's current MK: proves `base` is this vault's. */
  mk: KeyHandle
  /** The password's wrap of MK in `base` (`proveSecret`): where the old MK comes from for `history`. */
  proof: WrapProof
  /** The password the new header's wrap opens: unchanged for rotate and upgrade, the re-entered one for convert. */
  password: SecretBytes
  /** The new header's KDF, with a fresh salt (R-1); PBKDF2 for convert. */
  kdf: KdfParams
  profile: ProfileId
  /**
   * `upgrade` only: 3 when the upgrade gate allows it (PQ-B4, roadmap §3.6), so a v1 vault reaches v3 in one step;
   * 2 otherwise. Rotate and convert keep the base's version.
   */
  headerVersion?: 2 | 3
}

/** `vid || uint32be(e)`: the KBKDF Context of K_hist,e (audit §4.5.2). */
function historyContext(vaultId: string, epoch: number): Uint8Array {
  const ctx = new Uint8Array(20)
  ctx.set(vidOf(vaultId), 0)
  new DataView(ctx.buffer).setUint32(16, epoch, false)
  return ctx
}

/**
 * A history entry's AAD binds the vault, the profile, the epoch and that epoch's suite: epoch 0 of a vault upgraded
 * from header v1 (R-5) holds a suite-0x01 master key, every other entry a suite-0x02 one.
 */
function historyAad(header: Pick<VaultHeaderV2, 'vaultId' | 'profile'>, epoch: number, suite: number): Uint8Array {
  return utf8(`slate-vault/v2|${header.vaultId}|history|${header.profile}|${suite}|${epoch}`)
}

/** The suites an entry may hold: a suite-0x01 key only as epoch 0 of a standard vault (an upgraded v1 vault). */
function entrySuites(header: Pick<VaultHeaderV2, 'profile'>, epoch: number): number[] {
  return epoch === 0 && header.profile === 'standard' ? [SUITE.KBKDF_AES256GCM, SUITE.HKDF_AES256GCM] : [SUITE.KBKDF_AES256GCM]
}

const isAuthFailure = (e: unknown) => nativeErrorCode(e) === 'SCC_11'

/**
 * The header a rotation leads to has keys a device on `than` does not hold: a later key epoch, a later header
 * version (R-5), or a stronger profile (R-3). Only these are adopted by re-encrypting (`Migration.rejoin`).
 */
export function isNewerKeys(header: VaultHeader, than: VaultHeader): boolean {
  if (header.vaultId !== than.vaultId) return false
  // v1 → v2 is a rotation (R-5); v2 → v3 keeps every key (roadmap §3.4), so only epoch and profile tell them apart.
  if (header.version === 1 || than.version === 1) {
    if (header.version !== than.version) return header.version > than.version
  }
  if (profileRank(profileOf(header)) !== profileRank(profileOf(than))) return profileRank(profileOf(header)) > profileRank(profileOf(than))
  return header.version !== 1 && than.version !== 1 && header.keyEpoch > than.keyEpoch
}

/** The device slots of a v3 header (rule 10: carried, never opened, by this build). */
function deviceSlots(header: VaultHeader): [DeviceSlotName, DeviceWrap][] {
  if (header.version !== 3) return []
  return Object.entries(header.wraps).filter((e): e is [DeviceSlotName, DeviceWrap] => e[0].startsWith('device-'))
}

/** Rule 8: a fips-140-3 header holds only `mlkem1024-p384-kdf56c` device slots, so a conversion can carry only those. */
export function deviceSlotsAllow(header: VaultHeader, profile: ProfileId): boolean {
  return profile !== 'fips-140-3' || deviceSlots(header).every(([, w]) => w.alg === 'mlkem1024-p384-kdf56c')
}

/**
 * R-1/R-3/R-5: header v2 (v3 for a v3 base, or an upgrade the gate lets reach v3) at the next key epoch under a fresh MK (`keyRandom`) and a new recovery key (its slot cannot
 * be rewrapped without the old one), the password wrapped under a KEK from a fresh salt. Rotate and upgrade file the
 * old MK in `history` under K_hist of the new one (moved there from the password's proof, never as bytes) and move
 * the older entries along; convert leaves `history` empty (IG 2.4.A: an Argon2id-protected MK must not enter an
 * approved key tree). `createdAt` is when the current master key was made, so R-4's cryptoperiod counts from it.
 * A v3 base stays v3: `pq` and every device slot are copied byte for byte (rule 10); those slots still wrap the old MK
 * and stay unopened by this build.
 * Returns the new MK, which the caller owns; the recovery secret and every KEK are wiped here.
 */
export async function rekeyHeader(input: RekeyInput, opts: WeakKdfOption = {}): Promise<{ header: VaultHeaderV2 | VaultHeaderV3; mk: KeyHandle; recoveryKey: string }> {
  const { kind, base, proof } = input
  if (!verifyCheck(base, input.mk)) throw new WrongSecret()
  // The proof must be the base's own password wrap: what moves into history is then the MK `check` just verified.
  const own = base.wraps.password
  if (!equalBytes(proof.ct, Buffer.from(own.ct, 'base64')) || !equalBytes(proof.iv, Buffer.from(own.nonce, 'base64')) || !equalBytes(proof.aad, wrapAad(base, 'password'))) {
    throw new WrongSecret()
  }
  const from = profileOf(base)
  if (kind === 'convert' ? !(from === 'standard' && input.profile === 'fips-140-3') : input.profile !== from) {
    throw new RotationRefused(kind === 'convert' ? 'Only a standard vault converts, and only to FIPS 140-3' : 'A key rotation keeps the vault’s profile')
  }
  if (kind === 'upgrade' && base.version !== 1) throw new RotationRefused(`This vault already uses the version ${base.version} format`)
  if (kind === 'rotate' && base.version === 1) throw new RotationRefused('Upgrade this vault’s format first')
  if (!deviceSlotsAllow(base, input.profile)) throw new RotationRefused('This vault holds a device key a FIPS 140-3 vault cannot keep')
  if ((input.profile === 'fips-140-3') !== (input.kdf.alg === 'pbkdf2-hmac-sha512')) throw new RotationRefused(`A ${input.profile} vault cannot use ${input.kdf.alg}`)
  validateKdf(input.kdf, opts)
  checkProfileUsable(input.profile)
  const oldEpoch = base.version === 1 ? 0 : base.keyEpoch
  const older = base.version === 1 ? [] : (base.history ?? [])
  if (oldEpoch >= U32_MAX - 1) throw new RotationRefused('This vault has no key epoch left')
  if (kind !== 'convert' && older.length >= MAX_HISTORY) {
    throw new RotationRefused('Keys were rotated four times since the oldest files were replaced. Let sync finish on every device, then rotate again.')
  }
  const n = vaultNative()
  const body: Omit<VaultHeaderV2, 'check'> = {
    format: 'slate-vault',
    version: 2,
    vaultId: base.vaultId,
    revision: base.revision + 1,
    createdAt: Date.now(),
    profile: input.profile,
    suite: SUITE.KBKDF_AES256GCM,
    keyEpoch: oldEpoch + 1,
    kdf: input.kdf,
    wraps: { password: { alg: 'aes-256-gcm', nonce: '', ct: '' } },
  }
  const kek = await deriveKek(input.password, input.kdf, opts)
  let mk: KeyHandle | null = null
  let reopened: KeyHandle | null = null
  try {
    mk = n.keyRandom('master')
    body.wraps.password = seal(kek, mk, body, 'password')
    const sealed = sealRecovery(mk, body)
    body.wraps.recovery = sealed.wrap
    if (kind !== 'convert') {
      // The new MK as every later unlock sees it (through its password wrap), so its K_hist is exactly as approved as
      // the tree it heads: a standard vault's MK comes from Argon2id, and the module refuses to file a non-approved
      // key under an approved K_hist.
      const pw = body.wraps.password
      reopened = n.gcmOpenKey(kek, Buffer.from(pw.nonce, 'base64'), wrapAad(body, 'password'), Buffer.from(pw.ct, 'base64'), 'master')
      const oldSuite = base.version === 1 ? SUITE.HKDF_AES256GCM : SUITE.KBKDF_AES256GCM
      const entry = n.historySeal(proof.kek, proof.iv, proof.aad, proof.ct, reopened, historyContext(base.vaultId, oldEpoch), historyAad(body, oldEpoch, oldSuite))
      const history: HistoryEntry[] = [{ epoch: oldEpoch, ...(toWrap(body, entry) as WrapV2) }]
      for (const h of older) history.push({ epoch: h.epoch, ...(toWrap(body, rewrapHistory(base as VaultHeaderV2 | VaultHeaderV3, h, proof, reopened, body)) as WrapV2) })
      body.history = history
    }
    // Every wrap above used v2's AAD, which v3 shares (rule 9): v3 is the same body plus `pq` and the carried slots.
    const toV3 = base.version === 3 || (kind === 'upgrade' && input.headerVersion === 3)
    if (!toV3) return { header: finish(body, mk), mk, recoveryKey: sealed.recoveryKey }
    const pq = base.version === 3 ? structuredClone(base.pq) : { ...PQ_V3 }
    const wraps: VaultHeaderV3['wraps'] = { ...body.wraps }
    for (const [name, w] of deviceSlots(base)) wraps[name] = structuredClone(w)
    return { header: finish({ ...body, version: 3 as const, wraps, pq }, mk), mk, recoveryKey: sealed.recoveryKey }
  } catch (e) {
    destroyKey(mk)
    throw e
  } finally {
    destroyKey(reopened)
    destroyKey(kek)
  }
}

/** One older entry moved from K_hist of the base's MK (shown by the proof) to K_hist of the new MK, keeping its suite. */
function rewrapHistory(base: VaultHeaderV2 | VaultHeaderV3, h: HistoryEntry, proof: WrapProof, mkNew: KeyHandle, body: Pick<VaultHeaderV2, 'vaultId' | 'profile'>): Uint8Array {
  const n = vaultNative()
  const ctx = historyContext(base.vaultId, h.epoch)
  const iv = Buffer.from(h.nonce, 'base64')
  const ct = Buffer.from(h.ct, 'base64')
  for (const suite of entrySuites(base, h.epoch)) {
    try {
      return n.historyRewrap(proof.kek, proof.iv, proof.aad, proof.ct, ctx, iv, historyAad(base, h.epoch, suite), ct, mkNew, ctx, historyAad(body, h.epoch, suite))
    } catch (e) {
      if (!isAuthFailure(e)) throw e
    }
  }
  throw new BadHeader('A history entry does not open')
}

/** An earlier epoch's master key and the key schedule its files were sealed under. */
export interface EpochKey {
  mk: KeyHandle
  schedule: KeySchedule
}

/**
 * Every `history` entry `mk` (the header's current MK) opens, by epoch. An entry that does not open is left out:
 * its files stay unreadable, exactly as files of an unknown epoch. The caller owns the returned handles.
 */
export function openHistory(header: VaultHeader, mk: KeyHandle): Map<number, EpochKey> {
  const out = new Map<number, EpochKey>()
  if (header.version === 1) return out
  const n = vaultNative()
  for (const h of header.history ?? []) {
    for (const suite of entrySuites(header, h.epoch)) {
      try {
        const old = n.historyOpen(mk, historyContext(header.vaultId, h.epoch), Buffer.from(h.nonce, 'base64'), historyAad(header, h.epoch, suite), Buffer.from(h.ct, 'base64'))
        out.set(h.epoch, { mk: old, schedule: suite === SUITE.HKDF_AES256GCM ? SCHEDULE_V1 : scheduleV2(header.vaultId, header.profile, h.epoch) })
        break
      } catch (e) {
        if (!isAuthFailure(e)) {
          for (const k of out.values()) destroyKey(k.mk)
          throw e
        }
      }
    }
  }
  return out
}

/** R-2: `history` without `epochs` (no file of theirs is left), at the next revision. */
export function pruneHistory<H extends VaultHeaderV2 | VaultHeaderV3>(base: H, mk: KeyHandle, epochs: readonly number[]): H {
  const body = next(base, mk) as Omit<VaultHeaderV2 | VaultHeaderV3, 'check'> & { history?: HistoryEntry[] }
  const kept = (base.history ?? []).filter((h) => !epochs.includes(h.epoch))
  if (kept.length > 0) body.history = kept
  else delete body.history
  return finish(body as HeaderBody, mk) as H
}
