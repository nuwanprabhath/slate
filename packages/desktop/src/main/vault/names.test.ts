import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { vaultNative } from './native'
import { blobRemoteName, decodeId, encodeId, type IdKind } from './names'

const k = vaultNative().keyRandom()
const kinds: IdKind[] = ['notebook', 'page', 'device']
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('encodeId / decodeId', () => {
  it('round-trips many random uuids of every kind', () => {
    for (let i = 0; i < 3000; i++) {
      const kind = kinds[i % 3]!
      const uuid = randomUUID()
      const hex = encodeId(k, kind, uuid)
      expect(hex).toMatch(/^[0-9a-f]{32}$/)
      expect(decodeId(k, hex)).toEqual({ kind, uuid })
    }
  })

  it('refuses non-v4 and malformed ids and unknown kinds', () => {
    expect(() => encodeId(k, 'page', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toThrow()
    expect(() => encodeId(k, 'page', '6ba7b810-9dad-41d1-c0b4-00c04fd430c8')).toThrow()
    expect(() => encodeId(k, 'page', 'not-a-uuid')).toThrow()
    expect(() => encodeId(k, 'page', randomUUID().toUpperCase())).toThrow()
    expect(() => encodeId(k, 'blob' as IdKind, randomUUID())).toThrow()
  })

  it('different kinds and keys give different names', () => {
    const uuid = randomUUID()
    const names = new Set(kinds.map((kind) => encodeId(k, kind, uuid)))
    expect(names.size).toBe(3)
    expect(encodeId(vaultNative().keyRandom(), 'page', uuid)).not.toBe(encodeId(k, 'page', uuid))
    expect(decodeId(vaultNative().keyRandom(), encodeId(k, 'page', uuid))?.uuid).not.toBe(uuid)
  })

  it('forged names never throw and decode only to well-formed ids at the expected rate', () => {
    let valid = 0
    for (let i = 0; i < 10_000; i++) {
      const r = decodeId(k, randomBytes(16).toString('hex'))
      if (r) {
        valid++
        expect(kinds).toContain(r.kind)
        expect(r.uuid).toMatch(UUID4)
      }
    }
    // 3 of 16 kind codes × 1 of 4 variants ≈ 4.7 %.
    expect(valid).toBeGreaterThan(300)
    expect(valid).toBeLessThan(650)
    for (const junk of ['', 'zz', 'A'.repeat(32), '0'.repeat(31), '0'.repeat(34)]) expect(decodeId(k, junk)).toBeNull()
  })
})

describe('blobRemoteName', () => {
  it('is a stable keyed hex HMAC', () => {
    const a = blobRemoteName(k, 'abc.png')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(blobRemoteName(k, 'abc.png')).toBe(a)
    expect(blobRemoteName(k, 'abd.png')).not.toBe(a)
    expect(blobRemoteName(vaultNative().keyRandom(), 'abc.png')).not.toBe(a)
  })
})
