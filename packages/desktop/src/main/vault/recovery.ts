import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { moduleCopy, type SecretBytes } from '../../shared/secret'
import { vaultNative } from './native'

export class BadRecoveryKey extends Error {
  override name = 'BadRecoveryKey'
  constructor() {
    super('That recovery key is not valid. Check it for typos.')
  }
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const KEY_BYTES = 32
const DATA_CHARS = 52 // 256 bits + 4 zero padding bits
const CHECK_CHARS = 4 // first 20 bits of SHA-256(key)

function toBase32(bytes: Uint8Array, chars: number): string {
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  bits <<= BigInt(chars * 5 - bytes.length * 8)
  let out = ''
  for (let i = chars - 1; i >= 0; i--) out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)]
  return out
}

function checksum(key: Uint8Array): string {
  const h = vaultNative().sha256(key).subarray(0, 3) // 24 bits, the last 4 dropped
  return toBase32(h, 5).slice(0, CHECK_CHARS)
}

export function encodeRecovery(bytes: Uint8Array): string {
  if (bytes.length !== KEY_BYTES) throw new Error('A recovery key is 32 bytes')
  const text = toBase32(bytes, DATA_CHARS) + checksum(bytes)
  return text.match(/.{4}/g)!.join('-')
}

/**
 * The typed recovery key, decoded inside the module (C7): the 32-byte secret never exists in JavaScript.
 * Returns a recovery-class handle, whose only use is KEK_rc (`hkdfFromRecovery`); the caller destroys it.
 * `text` stays its owner's to zero (the module wipes its own copy). Throws BadRecoveryKey for a key that
 * does not decode or fails its checksum.
 */
export function decodeRecovery(text: SecretBytes): KeyHandle {
  try {
    return vaultNative().recoveryDecode(moduleCopy(text))
  } catch (e) {
    if (nativeErrorCode(e) === 'SCC_1') throw new BadRecoveryKey()
    throw e
  }
}

/**
 * A recovery key in its canonical form (upper case, groups of four), for the saved file. The module checks
 * it first (`decodeRecovery`), so only a well-formed key is ever written; the text itself is the one the
 * renderer already shows (the Z-11 residual of a freshly made key).
 */
export function canonicalRecoveryText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  try {
    vaultNative().keyDestroy(decodeRecovery(bytes))
  } finally {
    bytes.fill(0)
  }
  const chars = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return (chars.match(/.{4}/g) ?? []).join('-')
}
