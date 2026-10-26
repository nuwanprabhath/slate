import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BadRecoveryKey, decodeRecovery, encodeRecovery } from './recovery'
import { secretBytes } from '../../shared/secret'
import { destroyKey, vaultNative } from './native'
import { samePasswordKey } from '../../../test/vaultKeys'

/**
 * Whether `text` decodes to `key`. The decoded secret never leaves the module (C7), so this compares what
 * it does: KEK_rc from the decoded handle equals HKDF over the known bytes.
 */
function decodesTo(text: string, key: Uint8Array): boolean {
  const n = vaultNative()
  const salt = new TextEncoder().encode('e6be7b8b-3bf4-47af-add3-f30ad364caac')
  const handle = decodeRecovery(secretBytes(text))
  const a = n.hkdfFromRecovery(handle, salt, 'slate/v1/recovery')
  const b = n.hkdfFromSecret(new Uint8Array(key), salt, 'slate/v1/recovery')
  try {
    return samePasswordKey(a, b)
  } finally {
    for (const h of [handle, a, b]) destroyKey(h)
  }
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

describe('recovery key', () => {
  it('is 14 groups of 4 Crockford characters and round-trips', () => {
    for (let i = 0; i < 200; i++) {
      const key = randomBytes(32)
      const text = encodeRecovery(key)
      expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){13}$/)
      expect(decodesTo(text, key)).toBe(true)
    }
  })

  it('ignores case, spaces and dashes and maps O/I/L', () => {
    const key = randomBytes(32)
    const text = encodeRecovery(key)
    const sloppy = text.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect(decodesTo(`  ${sloppy} `, key)).toBe(true)
    expect(decodesTo(text.replace(/1/g, 'I').replace(/-/g, ''), key)).toBe(true)
  })

  it('refuses wrong lengths and unknown characters', () => {
    const text = encodeRecovery(randomBytes(32))
    expect(() => decodeRecovery(secretBytes(text.slice(0, -1)))).toThrow(BadRecoveryKey)
    expect(() => decodeRecovery(secretBytes(text + 'A'))).toThrow(BadRecoveryKey)
    expect(() => decodeRecovery(secretBytes('U' + text.slice(1)))).toThrow(BadRecoveryKey)
    expect(() => decodeRecovery(secretBytes(''))).toThrow(BadRecoveryKey)
    expect(() => encodeRecovery(randomBytes(31))).toThrow()
  })

  it('detects every single-character typo and adjacent transposition', () => {
    // Fixed keys and substitutions: a 20-bit checksum lets one random change in 2^20 through, so
    // random cases would fail now and then; these are checked once and stay checked.
    for (let n = 0; n < 20; n++) {
      const chars = encodeRecovery(createHash('sha256').update(`recovery-typo-${n}`).digest()).replace(/-/g, '')
      for (let i = 0; i < chars.length; i++) {
        const c = ALPHABET[(ALPHABET.indexOf(chars[i]!) + 1 + ((n + i) % 31)) % 32]!
        const typo = chars.slice(0, i) + c + chars.slice(i + 1)
        expect(() => decodeRecovery(secretBytes(typo)), `typo at ${i}`).toThrow(BadRecoveryKey)
        if (i + 1 < chars.length && chars[i] !== chars[i + 1]) {
          const swap = chars.slice(0, i) + chars[i + 1] + chars[i] + chars.slice(i + 2)
          expect(() => decodeRecovery(secretBytes(swap)), `swap at ${i}`).toThrow(BadRecoveryKey)
        }
      }
    }
  })

  it('C7: the typed text is decoded in the module; the caller keeps its bytes, the module wipes its copy', () => {
    const text = secretBytes(encodeRecovery(randomBytes(32)))
    const copy = new Uint8Array(text)
    const before = vaultNative().status().liveHandles
    const handle = decodeRecovery(text)
    expect(Array.from(text)).toEqual(Array.from(copy))
    expect(vaultNative().status().liveHandles).toBe(before + 1)
    destroyKey(handle)
    expect(vaultNative().status().liveHandles).toBe(before)
  })
})
