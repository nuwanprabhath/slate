// SLE2 (audit §4.5.3, C5 criterion 5): the Appendix A vector, the reference construction, padding, the
// profile's readSuites (T-POL-07) and T-FUZZ-05…09 against the v2 parser.
import { createDecipheriv } from 'node:crypto'
import * as zlib from 'node:zlib'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { KeyHandle } from '@slate/native'
import { forAll } from '../../../test/fuzz'
import { spyOnNative } from '../../../test/nativeSpy'
import { importKey, knownDataKey, liveHandles, refKbkdf } from '../../../test/vaultKeys'
import { FLAG, MAX_INFLATED_BYTES, UnverifiableFile, openEnvelope, padmeLength, pad, parseEnvelope, sealEnvelope, unpad, type EnvelopeKeys } from './envelope'
import { destroyKey, vaultNative } from './native'
import { PROFILES } from './profile'
import { SUITE, vidOf } from './suite'

vi.mock('node:zlib', async (original) => {
  const actual = await original<typeof import('node:zlib')>()
  return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync) }
})

const calls = spyOnNative()
const MK = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const VAULT = '00000000-0000-4000-8000-0000000000aa'
const KAT_PATH = 'docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk'
// Appendix A: K_sync = the KBKDF vector, epoch 0, salt 11 x 16, nonce 22 x 12, flags 0, pt "slate-kat-plaintext".
const KAT_SLE2 = '534c4532020000000000' + '11'.repeat(16) + '22'.repeat(12) + '3a8c6e82f7592e6a3ed5d5f220c3e5f3bb379958c3644102c211aff0aeda9375fff010'

const mk = importKey(MK, 'master')
const katSync = vaultNative().kbkdf(mk, 'slate/v2/sync', vidOf(VAULT))
const { key: kSync, bytes: kSyncBytes } = knownDataKey('slate/test/sync-v2')
afterAll(() => [mk, katSync, kSync].forEach((k) => destroyKey(k)))

const v2 = (syncKey: KeyHandle, profile: 'standard' | 'fips-140-3' = 'standard', keyEpoch = 0): EnvelopeKeys => ({
  syncKey,
  suite: SUITE.KBKDF_AES256GCM,
  keyEpoch,
  readSuites: PROFILES[profile].readSuites,
})
const plain = new TextEncoder().encode('a page of notes '.repeat(40))
const path = 'docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000002.chunk'

describe('SLE2: Appendix A and the reference construction (criterion 5)', () => {
  it('opens the Appendix A SLE2 vector to "slate-kat-plaintext"', () => {
    const bytes = Uint8Array.from(Buffer.from(KAT_SLE2, 'hex'))
    expect(new TextDecoder().decode(openEnvelope(v2(katSync), KAT_PATH, bytes))).toBe('slate-kat-plaintext')
    expect(parseEnvelope(bytes)).toMatchObject({ format: 'SLE2', suite: 2, flags: 0, keyEpoch: 0 })
  })

  it('what the module seals, the reference opens: header byte for byte, AAD = header ‖ "|" ‖ path, file key KBKDF(K_sync, "slate/v2/remote-file", salt)', () => {
    const sealed = sealEnvelope(v2(kSync, 'standard', 7), path, plain)
    expect(Buffer.from(sealed.subarray(0, 4)).toString()).toBe('SLE2')
    expect([sealed[4], sealed[5]]).toEqual([0x02, 0x00])
    expect(Buffer.from(sealed.subarray(6, 10)).readUInt32BE(0)).toBe(7)
    const salt = sealed.subarray(10, 26)
    const nonce = sealed.subarray(26, 38)
    const fileKey = refKbkdf(kSyncBytes, 'slate/v2/remote-file', salt)
    const d = createDecipheriv('aes-256-gcm', fileKey, nonce).setAAD(Buffer.concat([sealed.subarray(0, 38), Buffer.from('|' + path)]))
    d.setAuthTag(sealed.subarray(sealed.length - 16))
    expect(Buffer.concat([d.update(sealed.subarray(38, sealed.length - 16)), d.final()])).toEqual(Buffer.from(plain))
  })

  it('pads document records with Padmé (ISO/IEC 7816-4), and the padding is authenticated and removed', () => {
    const sealed = sealEnvelope(v2(kSync), path, plain, { deflate: true, pad: true })
    expect(sealed[5]).toBe(FLAG.DEFLATED | FLAG.PADDED)
    expect(openEnvelope(v2(kSync), path, sealed)).toEqual(plain)
    for (const n of [0, 1, 2, 15, 16, 100, 1000, 4097, 65_536]) {
      const body = new Uint8Array(n).fill(7)
      const p = pad(body)
      expect(p.length).toBe(padmeLength(n + 1))
      expect(p.length - n).toBeLessThanOrEqual(Math.max(1, Math.ceil((n + 1) * 0.12)) + 1)
      expect(unpad(p)).toEqual(body)
    }
    expect(() => unpad(new Uint8Array(8))).toThrow(UnverifiableFile)
  })

  it('a header-v1 vault still writes SLE1; nothing of SLE2 changes it', () => {
    const v1Keys: EnvelopeKeys = { syncKey: kSync, suite: SUITE.HKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites }
    const sealed = sealEnvelope(v1Keys, path, plain, { pad: true })
    expect(Buffer.from(sealed.subarray(0, 4)).toString()).toBe('SLE1')
    expect(sealed[4]).toBe(0)
  })

  it('a file of another key epoch or suite is not this vault’s: UnverifiableFile before any key is derived', () => {
    const sealed = sealEnvelope(v2(kSync, 'standard', 1), path, plain)
    calls.clear()
    expect(() => openEnvelope(v2(kSync, 'standard', 0), path, sealed)).toThrow(/a key this vault does not hold/)
    expect(calls.get('kbkdf') ?? 0).toBe(0)
  })
})

describe('T-POL-07: fips-140-3 refuses suite 0x01 by readSuites', () => {
  it('an SLE1 file is UnverifiableFile, and no legacy primitive is called', () => {
    const sle1 = sealEnvelope({ syncKey: kSync, suite: SUITE.HKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites }, path, plain)
    calls.clear()
    expect(() => openEnvelope(v2(kSync, 'fips-140-3'), path, sle1)).toThrow(/cipher suite this vault does not accept/)
    expect([...calls.keys()]).toEqual([])
  })
})

describe('T-FUZZ-05…09: parseEnvelope and openEnvelope under hostile input', () => {
  it('T-FUZZ-05: random bytes give only UnverifiableFile', () => {
    forAll('T-FUZZ-05', (rng) => {
      const bytes = rng.bytes(512)
      if (rng.bool() && bytes.length >= 4) bytes.set([0x53, 0x4c, 0x45, rng.pick([0x31, 0x32])], 0)
      try {
        parseEnvelope(bytes)
      } catch (e) {
        expect(e).toBeInstanceOf(UnverifiableFile)
      }
    })
  })

  it('T-FUZZ-06: valid SLE2 magic with any suite and flags: unknown suites and flags are refused structurally', () => {
    forAll('T-FUZZ-06', (rng) => {
      const suite = rng.int(0, 255)
      const flags = rng.int(0, 255)
      const bytes = Uint8Array.from([0x53, 0x4c, 0x45, 0x32, suite, flags, ...rng.bytes(100)])
      const ok = suite === 0x02 && (flags & ~0x03) === 0 && bytes.length >= 38 + 16
      if (ok) expect(parseEnvelope(bytes).suite).toBe(0x02)
      else expect(() => parseEnvelope(bytes)).toThrow(UnverifiableFile)
    })
    for (let suite = 0x03; suite <= 0x1f; suite++) {
      expect(() => parseEnvelope(Uint8Array.from([0x53, 0x4c, 0x45, 0x32, suite, 0, ...new Uint8Array(60)])), `reserved ${suite}`).toThrow(/Unknown cipher suite/)
    }
  })

  it('T-FUZZ-07: every truncation of a real SLE2 file is refused below 54 bytes, otherwise parsed with the right length', () => {
    const real = Uint8Array.from(Buffer.from(KAT_SLE2, 'hex'))
    for (let len = 0; len < real.length; len++) {
      const cut = real.subarray(0, len)
      if (len < 38 + 16) expect(() => parseEnvelope(cut), String(len)).toThrow(UnverifiableFile)
      else expect(parseEnvelope(cut).ctAndTag.length).toBe(len - 38)
      if (len >= 38 + 16 && len < real.length) expect(() => openEnvelope(v2(katSync), KAT_PATH, cut)).toThrow(UnverifiableFile)
    }
  })

  it('T-FUZZ-08: 1–8 bit flips anywhere, or another path: only UnverifiableFile, and zlib never sees unauthenticated bytes', () => {
    const sealed = sealEnvelope(v2(kSync), path, plain, { deflate: true, pad: true })
    const inflate = vi.mocked(zlib.inflateRawSync)
    inflate.mockClear()
    const before = liveHandles()
    forAll(
      'T-FUZZ-08',
      (rng) => {
        const bad = Uint8Array.from(sealed)
        for (let i = rng.int(1, 8); i > 0; i--) {
          const bit = rng.int(0, bad.length * 8 - 1)
          bad[bit >> 3]! ^= 1 << (bit & 7)
        }
        expect(() => openEnvelope(v2(kSync), path, bad)).toThrow(UnverifiableFile)
      },
      300,
    )
    expect(() => openEnvelope(v2(kSync), path.replace('00000002', '00000003'), sealed)).toThrow(UnverifiableFile)
    expect(inflate).not.toHaveBeenCalled()
    expect(liveHandles()).toBe(before)
    expect(openEnvelope(v2(kSync), path, sealed)).toEqual(plain)
    expect(inflate).toHaveBeenCalledTimes(1)
  })

  it('T-FUZZ-09: a validly sealed 2 MiB of zeros opened with maxInflated 1 MiB is "too large or damaged"', () => {
    const sealed = sealEnvelope(v2(kSync), path, new Uint8Array(2 * 1024 * 1024), { deflate: true })
    expect(() => openEnvelope(v2(kSync), path, sealed, { maxInflated: 1024 * 1024 })).toThrow('This file is too large or damaged')
    expect(MAX_INFLATED_BYTES).toBe(256 * 1024 * 1024)
  })

  it('refuses a sealed file above 64 MiB before reading it', () => {
    const huge = new Uint8Array(64 * 1024 * 1024 + 1)
    huge.set([0x53, 0x4c, 0x45, 0x32, 0x02, 0x00], 0)
    expect(() => parseEnvelope(huge)).toThrow('This file is too large')
  })
})
