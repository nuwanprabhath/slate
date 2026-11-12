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

const GROUP = 4 // characters between the '-' separators
const DASH = 0x2d
const CHARS = DATA_CHARS + CHECK_CHARS
/** 56 characters in 14 groups of four, 13 separators between them. */
const TEXT_BYTES = CHARS + Math.floor((CHARS - 1) / GROUP)

/** Where the `i`th character sits once the separators are in. */
const at = (i: number): number => i + Math.floor(i / GROUP)

/**
 * `chars` Crockford base32 characters of `bytes`, written as ASCII into `out` at the character positions
 * from `first`, with a '-' after every fourth character of the whole key.
 *
 * Bits are read from the front, five at a time, and the last character is padded with zeros on the right
 * (52 characters carry 256 bits plus 4 of padding). Numbers throughout: the key must not become a
 * JavaScript string or a BigInt here, because neither can be zeroed and both survive in V8's heap after
 * the reference is dropped (POAM-10, T-ZERO-09).
 */
function writeBase32(bytes: Uint8Array, chars: number, out: Uint8Array, first: number): void {
  let acc = 0
  let bits = 0
  let written = 0
  for (let i = 0; i < bytes.length && written < chars; i++) {
    acc = (acc << 8) | (bytes[i] ?? 0)
    bits += 8
    while (bits >= 5 && written < chars) {
      bits -= 5
      const n = first + written++
      out[at(n)] = ALPHABET.charCodeAt((acc >>> bits) & 31)
      if (n % GROUP === GROUP - 1 && at(n) + 1 < out.length) out[at(n) + 1] = DASH
    }
    acc &= (1 << bits) - 1
  }
  while (written < chars) {
    const n = first + written++
    out[at(n)] = ALPHABET.charCodeAt((acc << (5 - bits)) & 31)
    if (n % GROUP === GROUP - 1 && at(n) + 1 < out.length) out[at(n) + 1] = DASH
    acc = 0
    bits = 0
  }
}

/**
 * The displayed recovery key, as the ASCII bytes of its 14 groups: 52 characters of the 32-byte secret and
 * a 4-character checksum over it. The caller owns the bytes and zeroes them (`zeroSecret`); main must never
 * hold this key as a string, which is what `decodeRecovery` already avoids in the other direction (C7).
 */
export function encodeRecovery(bytes: Uint8Array): SecretBytes {
  if (bytes.length !== KEY_BYTES) throw new Error('A recovery key is 32 bytes')
  const out = new Uint8Array(TEXT_BYTES)
  // 24 bits of SHA-256(key), of which the checksum keeps the first 20. Derived from the key, so it is
  // zeroed with everything else rather than left for the heap scan to find.
  const digest = vaultNative().sha256(bytes)
  try {
    writeBase32(bytes, DATA_CHARS, out, 0)
    writeBase32(digest.subarray(0, 3), CHECK_CHARS, out, DATA_CHARS)
    return out
  } catch (e) {
    out.fill(0)
    throw e
  } finally {
    digest.fill(0)
  }
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
