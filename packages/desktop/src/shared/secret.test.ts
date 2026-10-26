import { describe, expect, it } from 'vitest'
import { moduleCopy, passwordBytes, secretBytes, zeroSecret } from './secret'

describe('typed secrets as bytes (Z-5, C7)', () => {
  it('encodes NFC then UTF-8, so a composed and a decomposed password are the same bytes', () => {
    expect(Array.from(secretBytes('é'))).toEqual(Array.from(secretBytes('é')))
    expect(Array.from(secretBytes('é'))).toEqual([0xc3, 0xa9])
  })

  it('zeroes every array it is given, and ignores missing ones', () => {
    const a = secretBytes('one password')
    const b = secretBytes('another')
    zeroSecret(a, null, b, undefined)
    expect([...a, ...b].every((x) => x === 0)).toBe(true)
  })

  it('main accepts only a Uint8Array of 1 to 4096 bytes', () => {
    const ok = new Uint8Array(4096)
    expect(passwordBytes(ok)).toBe(ok)
    expect(passwordBytes(new Uint8Array(1))).not.toBeNull()
    for (const bad of ['a password', new Uint8Array(0), new Uint8Array(4097), new Uint16Array(4), [1, 2, 3], { length: 3 }, null, undefined, 42]) {
      expect(passwordBytes(bad)).toBeNull()
    }
  })

  it('moduleCopy is the same bytes in an ArrayBuffer of its own, exactly the secret long (T-ZERO-04)', () => {
    const pw = secretBytes('a short password')
    const copy = moduleCopy(pw)
    expect(Array.from(copy)).toEqual(Array.from(pw))
    expect(copy.buffer).not.toBe(pw.buffer)
    expect([copy.byteOffset, copy.buffer.byteLength]).toEqual([0, pw.byteLength])
    zeroSecret(copy)
    expect(pw.some((b) => b !== 0)).toBe(true)
  })
})
