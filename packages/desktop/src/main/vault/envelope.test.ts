import { randomBytes } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { dataKeyMatches, knownDataKey, liveHandles, passwordKeyMatches, refHkdf } from '../../../test/vaultKeys'
import { UnverifiableFile, openEnvelope, sealEnvelope, type EnvelopeKeys } from './envelope'
import { PROFILES } from './profile'
import { SUITE } from './suite'
import { destroyKey, vaultNative } from './native'

const kSync = knownDataKey('slate/v1/sync').key
const v1 = (syncKey: KeyHandle): EnvelopeKeys => ({ syncKey, suite: SUITE.HKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites })
afterAll(() => destroyKey(kSync))
const path = 'docs/page:x/dev/00000001.chunk'

function code(fn: () => unknown): string | null {
  try {
    fn()
  } catch (e) {
    return nativeErrorCode(e)
  }
  return null
}

describe('hkdf (suite 0x01, in the module)', () => {
  it('matches RFC 5869 HKDF-SHA-256 (node:crypto as the reference)', () => {
    const ikm = new Uint8Array(22).fill(0x0b)
    const salt = new Uint8Array(13).map((_, i) => i)
    const fromSecret = vaultNative().hkdfFromSecret(ikm.slice(), salt, 'slate/v1/recovery')
    // A password-class key never leaves the module: it must hold the reference bytes by what it wraps.
    expect(passwordKeyMatches(fromSecret, refHkdf(ikm, salt, 'slate/v1/recovery'))).toBe(true)
    expect(passwordKeyMatches(fromSecret, refHkdf(ikm, salt, 'slate/v1/quick'))).toBe(false)
    destroyKey(fromSecret)
  })

  it('gives 32-byte keys and separates info strings', () => {
    const { key: k, bytes } = knownDataKey()
    const a = vaultNative().hkdfLegacy(k, new Uint8Array(0), 'a')
    const b = vaultNative().hkdfLegacy(k, new Uint8Array(0), 'b')
    expect(dataKeyMatches(a, refHkdf(bytes, new Uint8Array(0), 'a'))).toBe(true)
    expect(dataKeyMatches(b, refHkdf(bytes, new Uint8Array(0), 'a'))).toBe(false)
    expect(dataKeyMatches(b, refHkdf(bytes, new Uint8Array(0), 'b'))).toBe(true)
    for (const h of [k, a, b]) destroyKey(h)
  })
})

describe('gcm (in the module)', () => {
  it('round-trips and binds the AAD', () => {
    const n = vaultNative()
    const key = n.keyRandom()
    const other = n.keyRandom()
    const aad = new TextEncoder().encode('aad')
    const sealed = n.gcmSeal(key, null, aad, new TextEncoder().encode('hello'))
    const nonce = sealed.subarray(0, 12)
    const ct = sealed.subarray(12)
    expect(nonce).toHaveLength(12)
    expect(ct).toHaveLength(5 + 16)
    expect(new TextDecoder().decode(n.gcmOpen(key, nonce, aad, ct))).toBe('hello')
    expect(code(() => n.gcmOpen(key, nonce, new TextEncoder().encode('aaX'), ct))).toBe('SCC_11')
    expect(code(() => n.gcmOpen(other, nonce, aad, ct))).toBe('SCC_11')
    expect(code(() => n.gcmOpen(key, nonce, aad, ct.subarray(0, 10)))).toBe('SCC_11')
    expect(code(() => n.gcmOpen(key, nonce.subarray(0, 8), aad, ct))).toBe('SCC_11')
    destroyKey(key)
    destroyKey(other)
  })
})

describe('envelope', () => {
  const plain = new TextEncoder().encode('some page content '.repeat(50))

  it('round-trips plain and deflated', () => {
    const a = sealEnvelope(v1(kSync), path, plain)
    expect(Buffer.from(a.subarray(0, 4)).toString()).toBe('SLE1')
    expect(a[4]).toBe(0)
    expect(openEnvelope(v1(kSync), path, a)).toEqual(plain)
    const b = sealEnvelope(v1(kSync), path, plain, { deflate: true })
    expect(b[4]).toBe(1)
    expect(b.length).toBeLessThan(a.length)
    expect(openEnvelope(v1(kSync), path, b)).toEqual(plain)
  })

  it('rejects path swap, any flipped byte and truncation', () => {
    const sealed = sealEnvelope(v1(kSync), path, plain, { deflate: true })
    const other = vaultNative().keyRandom()
    expect(() => openEnvelope(v1(kSync), 'blobs/other', sealed)).toThrow(UnverifiableFile)
    expect(() => openEnvelope(v1(other), path, sealed)).toThrow(UnverifiableFile)
    destroyKey(other)
    for (let i = 0; i < sealed.length; i += i < 40 ? 1 : 17) {
      const bad = Uint8Array.from(sealed)
      bad[i]! ^= 0x01
      expect(() => openEnvelope(v1(kSync), path, bad), `byte ${i}`).toThrow(UnverifiableFile)
    }
    for (const n of [0, 3, 20, 33, 48, sealed.length - 1]) {
      expect(() => openEnvelope(v1(kSync), path, sealed.subarray(0, n)), `len ${n}`).toThrow(UnverifiableFile)
    }
  })

  it('UnverifiableFile is catchable by name', () => {
    try {
      openEnvelope(v1(kSync), path, new Uint8Array(10))
    } catch (e) {
      expect((e as Error).name).toBe('UnverifiableFile')
    }
  })

  it('caps the inflated size, after authenticating', () => {
    const big = new Uint8Array(2 * 1024 * 1024)
    const sealed = sealEnvelope(v1(kSync), path, big, { deflate: true })
    expect(() => openEnvelope(v1(kSync), path, sealed, { maxInflated: 1024 * 1024 })).toThrow(UnverifiableFile)
    expect(openEnvelope(v1(kSync), path, sealed, { maxInflated: 2 * 1024 * 1024 })).toHaveLength(big.length)
  })

  it('returns the raw deflated bytes when asked not to inflate', () => {
    const sealed = sealEnvelope(v1(kSync), path, plain, { deflate: true })
    expect(Buffer.from(openEnvelope(v1(kSync), path, sealed, { inflate: false }))).toEqual(deflateRawSync(plain))
  })

  it('never reuses a salt or nonce over 10k seals, and leaves no file key behind', () => {
    const salts = new Set<string>()
    const nonces = new Set<string>()
    const before = liveHandles()
    for (let i = 0; i < 10_000; i++) {
      const s = sealEnvelope(v1(kSync), path, plain.subarray(0, 8))
      salts.add(Buffer.from(s.subarray(5, 21)).toString('hex'))
      nonces.add(Buffer.from(s.subarray(21, 33)).toString('hex'))
    }
    expect(salts.size).toBe(10_000)
    expect(nonces.size).toBe(10_000)
    expect(liveHandles()).toBe(before)
  })
})
