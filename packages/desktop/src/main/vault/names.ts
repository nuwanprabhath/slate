// Remote folder names (§15 N1, audit §4.6): deterministic and reversible without a map, so the engine's
// `delta` rebuilds logical paths without downloading anything. Suite 0x02 names are SIV-style and
// authenticated (64 hex): hex(SIV ‖ C), SIV = HMAC-SHA-256(K_name_mac, "slate-name/v2" ‖ 0x00 ‖ P)[0..16),
// C = AES-256-CTR(K_name_enc, ICB = SIV, P), computed and checked inside the module (nameSivEncode/Decode).
// Suite 0x01 names (32 hex) are one AES-ECB block, kept for header-v1 vaults (the "legacy use" SP 800-131A
// r3 allows), through the v1 read path.
import type { KeyHandle } from '@slate/native'
import { toHex, utf8, vaultNative } from './native'
import { v1NameBlock } from './suite1'

export type IdKind = 'notebook' | 'page' | 'device'

/** The name keys of a vault: suite 0x02 needs both, suite 0x01 only `enc`. */
export interface NameKeys {
  enc: KeyHandle
  mac: KeyHandle
}

const CODE: Record<IdKind, number> = { notebook: 1, page: 2, device: 3 }
const KIND = new Map<number, IdKind>(Object.entries(CODE).map(([k, v]) => [v, k as IdKind]))
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'))

/** P: the 16 uuid bytes with the version nibble (byte 6, high half) replaced by the kind code. */
function pack(kind: IdKind, uuid: string): Uint8Array {
  const code = Object.hasOwn(CODE, kind) ? CODE[kind] : undefined
  if (!code) throw new Error(`Unknown id kind: ${String(kind)}`)
  if (!UUID4.test(uuid)) throw new Error(`Not a version 4 uuid: ${uuid}`)
  const packed = fromHex(uuid.replace(/-/g, ''))
  packed[6] = (code << 4) | (packed[6]! & 0x0f)
  return packed
}

/** The kind and uuid of P, or null unless the kind code is known and the variant bits are 10. */
function unpack(b: Uint8Array): { kind: IdKind; uuid: string } | null {
  const kind = KIND.get(b[6]! >> 4)
  if (!kind || (b[8]! & 0xc0) !== 0x80) return null
  b[6] = 0x40 | (b[6]! & 0x0f)
  const h = toHex(b)
  return { kind, uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` }
}

export function encodeId(kNameEnc: KeyHandle, kind: IdKind, uuid: string): string {
  return toHex(v1NameBlock(kNameEnc, pack(kind, uuid), true))
}

/** Null for anything that is not one of our names: a forged name decodes to garbage and is ignored. */
export function decodeId(kNameEnc: KeyHandle, hex: string): { kind: IdKind; uuid: string } | null {
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return unpack(v1NameBlock(kNameEnc, fromHex(hex), false))
}

/** Suite 0x02: 64 lowercase hex characters. */
export function encodeIdV2(keys: NameKeys, kind: IdKind, uuid: string): string {
  return toHex(vaultNative().nameSivEncode(keys.enc, keys.mac, pack(kind, uuid)))
}

/** Null for anything that is not one of our names: a forged or altered name fails the SIV (1 − 2^-128). Never throws on remote input. */
export function decodeIdV2(keys: NameKeys, hex: string): { kind: IdKind; uuid: string } | null {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) return null
  const packed = vaultNative().nameSivDecode(keys.enc, keys.mac, fromHex(hex))
  return packed ? unpack(packed) : null
}

export function blobRemoteName(kName: KeyHandle, name: string): string {
  return toHex(vaultNative().hmacSha256(kName, utf8('blob|' + name)))
}
