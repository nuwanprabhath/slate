// The remote-file envelopes (audit §4.5.3, listing B.5). SLE2 (suite 0x02) is what every header-v2 vault
// writes: `SLE2 | suite | flags | keyEpoch32 | salt16 | nonce12 | ct+tag`, with the whole header and the
// logical path in the AAD. SLE1 (suite 0x01, `SLE1 | flags | salt16 | nonce12 | ct+tag`) is written and read
// only by a header-v1 vault, byte for byte as the audited vault/crypto.ts did (C4 criterion 2). Every
// primitive runs in @slate/native: the file key is a handle derived from K_sync, the nonce comes from the
// module's DRBG, and the module binds it into the AAD.
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { utf8, vaultNative } from './native'
import { SUITE, type SuiteId } from './suite'
import { v1FileKey } from './suite1'

/** A remote file that does not authenticate (§5.5). The sync engine never falls back to plaintext. */
export class UnverifiableFile extends Error {
  override name = 'UnverifiableFile'
  constructor(reason = 'This file could not be verified') {
    super(reason)
  }
}

export const FLAG = { DEFLATED: 0x01, PADDED: 0x02 } as const
const SLE1_KNOWN_FLAGS = FLAG.DEFLATED
const SLE2_KNOWN_FLAGS = FLAG.DEFLATED | FLAG.PADDED
const MAGIC1 = utf8('SLE1')
const MAGIC2 = utf8('SLE2')
const SALT = 16
const NONCE = 12
const TAG = 16
const SLE1_NONCE_AT = 4 + 1 + SALT
const SLE1_HEADER = SLE1_NONCE_AT + NONCE // 33
const SLE2_NONCE_AT = 4 + 1 + 1 + 4 + SALT // 26
const SLE2_HEADER = SLE2_NONCE_AT + NONCE // 38
export const MAX_SEALED_BYTES = 64 * 1024 * 1024
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024

export interface ParsedEnvelope {
  format: 'SLE1' | 'SLE2'
  suite: SuiteId
  flags: number
  keyEpoch: number
  salt: Uint8Array
  nonce: Uint8Array
  /** Exactly the bytes bound into the AAD. */
  header: Uint8Array
  ctAndTag: Uint8Array
}

function hasMagic(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false
  return true
}

/** Structure only, no keys: every rejection is UnverifiableFile, and nothing here allocates more than the input. */
export function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  if (bytes.length > MAX_SEALED_BYTES) throw new UnverifiableFile('This file is too large')
  if (hasMagic(bytes, MAGIC2)) {
    if (bytes.length < SLE2_HEADER + TAG) throw new UnverifiableFile()
    const suite = bytes[4]
    const flags = bytes[5] ?? 0xff
    // The suite registry: only 0x02 is an SLE2 suite; 0x03-0x1F are reserved and refused like any other.
    if (suite !== SUITE.KBKDF_AES256GCM) throw new UnverifiableFile('Unknown cipher suite')
    if ((flags & ~SLE2_KNOWN_FLAGS) !== 0) throw new UnverifiableFile()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return {
      format: 'SLE2',
      suite,
      flags,
      keyEpoch: view.getUint32(6, false),
      salt: bytes.subarray(10, 10 + SALT),
      nonce: bytes.subarray(SLE2_NONCE_AT, SLE2_HEADER),
      header: bytes.subarray(0, SLE2_HEADER),
      ctAndTag: bytes.subarray(SLE2_HEADER),
    }
  }
  if (hasMagic(bytes, MAGIC1)) {
    if (bytes.length < SLE1_HEADER + TAG) throw new UnverifiableFile()
    const flags = bytes[4] ?? 0xff
    if ((flags & ~SLE1_KNOWN_FLAGS) !== 0) throw new UnverifiableFile()
    return {
      format: 'SLE1',
      suite: SUITE.HKDF_AES256GCM,
      flags,
      keyEpoch: 0,
      salt: bytes.subarray(5, 5 + SALT),
      nonce: bytes.subarray(SLE1_NONCE_AT, SLE1_HEADER),
      header: bytes.subarray(0, SLE1_HEADER),
      ctAndTag: bytes.subarray(SLE1_HEADER),
    }
  }
  throw new UnverifiableFile()
}

function aad(header: Uint8Array, logicalPath: string): Uint8Array {
  const tail = utf8('|' + logicalPath)
  const out = new Uint8Array(header.length + tail.length)
  out.set(header, 0)
  out.set(tail, header.length)
  return out
}

/** Padmé (Nikitin et al., PETS 2019): at most ~12% overhead, leaks O(log log L) bits of the length. */
export function padmeLength(len: number): number {
  if (len < 2) return len
  const e = Math.floor(Math.log2(len))
  const s = Math.floor(Math.log2(e)) + 1
  const mask = 2 ** (e - s) - 1
  return Math.ceil(len / (mask + 1)) * (mask + 1)
}

/** ISO/IEC 7816-4 padding (0x80 then zeros) up to padmeLength(len + 1). */
export function pad(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(padmeLength(body.length + 1))
  out.set(body, 0)
  out[body.length] = 0x80
  return out
}

export function unpad(padded: Uint8Array): Uint8Array {
  let i = padded.length - 1
  while (i >= 0 && padded[i] === 0) i--
  if (i < 0 || padded[i] !== 0x80) throw new UnverifiableFile()
  return padded.subarray(0, i)
}

/**
 * Which K_sync a vault seals and opens with. A vault holds one key schedule, so it writes one suite under
 * its current key epoch; `readSuites` is its profile's (a fips-140-3 vault never reads suite 0x01).
 */
export interface EnvelopeKeys {
  readonly syncKey: KeyHandle
  readonly suite: SuiteId
  readonly keyEpoch: number
  readonly readSuites: ReadonlySet<SuiteId>
}

/** The caller destroys the returned file key. */
function fileKey(suite: SuiteId, kSync: KeyHandle, salt: Uint8Array): KeyHandle {
  return suite === SUITE.KBKDF_AES256GCM ? vaultNative().kbkdf(kSync, 'slate/v2/remote-file', salt) : v1FileKey(kSync, salt)
}

export interface SealOptions {
  deflate?: boolean
  /** SLE2 only: Padmé padding (F-BSI-04). On for document chunks, snapshots and device records; off for blobs. */
  pad?: boolean
}

/** Seal order: deflate (optional), then pad (optional, SLE2), then GCM under a fresh file key and module IV. */
export function sealEnvelope(keys: EnvelopeKeys, logicalPath: string, plaintext: Uint8Array, opts: SealOptions = {}): Uint8Array {
  const n = vaultNative()
  let body = opts.deflate ? new Uint8Array(deflateRawSync(plaintext)) : plaintext
  const v2 = keys.suite === SUITE.KBKDF_AES256GCM
  const padded = v2 && opts.pad === true
  if (padded) body = pad(body)
  const flags = (opts.deflate ? FLAG.DEFLATED : 0) | (padded ? FLAG.PADDED : 0)
  const headerLen = v2 ? SLE2_HEADER : SLE1_HEADER
  const nonceAt = v2 ? SLE2_NONCE_AT : SLE1_NONCE_AT
  const header = new Uint8Array(headerLen)
  const salt = n.randomBytes(SALT)
  if (v2) {
    header.set(MAGIC2, 0)
    header[4] = SUITE.KBKDF_AES256GCM
    header[5] = flags
    new DataView(header.buffer).setUint32(6, keys.keyEpoch, false)
    header.set(salt, 10)
  } else {
    header.set(MAGIC1, 0)
    header[4] = flags
    header.set(salt, 5)
  }
  const fk = fileKey(keys.suite, keys.syncKey, salt)
  try {
    // The nonce is part of the authenticated header, so the module writes the IV it draws into the AAD.
    const sealed = n.gcmSealIvInAad(fk, aad(header, logicalPath), nonceAt, body)
    header.set(sealed.subarray(0, NONCE), nonceAt)
    const out = new Uint8Array(headerLen + sealed.length - NONCE)
    out.set(header, 0)
    out.set(sealed.subarray(NONCE), headerLen)
    return out
  } finally {
    n.keyDestroy(fk)
  }
}

/**
 * Open order (audit §4.5.3): size cap, structural parse, suite allowed?, key for the epoch?, GCM open (a failed
 * tag is UnverifiableFile; the module's error state or any other module failure is rethrown), unpad, inflate
 * capped. Only authenticated bytes reach zlib.
 */
export function openEnvelope(
  keys: EnvelopeKeys,
  logicalPath: string,
  bytes: Uint8Array,
  opts: { inflate?: boolean; maxInflated?: number } = {},
): Uint8Array {
  const n = vaultNative()
  const env = parseEnvelope(bytes)
  if (!keys.readSuites.has(env.suite)) throw new UnverifiableFile('This file uses a cipher suite this vault does not accept')
  // A vault holds the key of one suite and one epoch (history arrives with C9): anything else is not ours.
  if (env.suite !== keys.suite || env.keyEpoch !== keys.keyEpoch) throw new UnverifiableFile('This file was sealed under a key this vault does not hold')
  let body: Uint8Array
  const fk = fileKey(env.suite, keys.syncKey, env.salt)
  try {
    body = n.gcmOpen(fk, env.nonce, aad(env.header, logicalPath), env.ctAndTag)
  } catch (e) {
    // Only a failed tag (SCC_11) or an oversized file (SCC_14) is the file's fault. The module's error state
    // (SCC_12) or any other module failure must not read as "could not be verified" (review C4 L1).
    const code = nativeErrorCode(e)
    if (code !== null && code !== 'SCC_11' && code !== 'SCC_14') throw e
    throw new UnverifiableFile()
  } finally {
    n.keyDestroy(fk)
  }
  if (env.flags & FLAG.PADDED) body = unpad(body)
  if (!(env.flags & FLAG.DEFLATED) || opts.inflate === false) return body
  try {
    // A deflate bomb is still possible from someone holding K_sync, so the cap is what bounds memory.
    return new Uint8Array(inflateRawSync(body, { maxOutputLength: opts.maxInflated ?? MAX_INFLATED_BYTES }))
  } catch {
    throw new UnverifiableFile('This file is too large or damaged')
  }
}
