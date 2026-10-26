// T-FUZZ (audit §6.4) against the v1 and v2 parsers: only each parser's own error, nothing silently dropped
// or coerced, KDF bounds over the whole integer range, RFC 8785 key order, and SIV names that decode only when
// they are ours. Deterministic: seed 0x51a7e, 2000 runs (test/fuzz.ts).
import { randomBytes } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { apply, fcParams, forAll, fuzzTimeout, jsonValue, mutation, Rng } from '../../../test/fuzz'
import { importKey, knownDataKey, samePasswordKey } from '../../../test/vaultKeys'
import { openEnvelope, parseEnvelope, sealEnvelope, UnverifiableFile } from './envelope'
import { PROFILES } from './profile'
import { SUITE } from './suite'
import type { KeyHandle } from '@slate/native'
import { secretBytes } from '../../shared/secret'
import { BadHeader, canonicalJson, parseHeader, parseHeaderV2 } from './header'
import { parseLocalKeys, BadLocalKeys } from './localKeys'
import { decodeIdV2, encodeIdV2 } from './names'
import { vaultNative } from './native'
import { parsePreunlockFile } from './preunlock'
import { parseProfileFloor } from './profileFloor'
import { parseQuickUnlock } from './quickUnlock'
import { BadRecoveryKey, decodeRecovery, encodeRecovery } from './recovery'
import { vidOf } from './suite'

const b64 = (n: number, fill = 7) => Buffer.alloc(n, fill).toString('base64')
const wrap = () => ({ alg: 'aes-256-gcm', nonce: b64(12, 1), ct: b64(48, 2) })
const VALID_V2 = {
  format: 'slate-vault',
  version: 2,
  vaultId: '00000000-0000-4000-8000-0000000000aa',
  revision: 1,
  createdAt: 1761200000000,
  profile: 'standard',
  suite: 2,
  keyEpoch: 0,
  kdf: { alg: 'argon2id', memoryKiB: 262144, passes: 4, parallelism: 1, salt: b64(16) },
  wraps: { password: wrap(), recovery: wrap() },
  check: b64(32, 0),
}
const VALID_V2_FIPS = { ...VALID_V2, profile: 'fips-140-3', kdf: { alg: 'pbkdf2-hmac-sha512', iterations: 1_000_000, salt: b64(32) } }
const VALID_V1 = {
  format: 'slate-vault',
  version: 1,
  vaultId: '00000000-0000-4000-8000-0000000000aa',
  revision: 1,
  createdAt: 1761200000000,
  kdf: { alg: 'argon2id', memoryKiB: 262144, passes: 4, parallelism: 1, salt: b64(16) },
  wraps: { password: { nonce: b64(12), ct: b64(48) } },
  check: b64(32),
}

const throwsOnly = (fn: () => unknown, Err: new (...a: never[]) => Error): void => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(Err)
  }
}

/**
 * The parse-time bound of T-FUZZ-01 (< 5 ms a parse) as an average over every run, with a generous ceiling on any
 * one: at the soak's 200,000 runs on a shared runner, a GC pause or a preemption would trip a strict per-run bound
 * with no bug behind it, while a parser that is slow on some input class still moves the average or the ceiling.
 */
function parseCost(): { time(fn: () => void): void; check(): void } {
  let total = 0
  let runs = 0
  let worst = 0
  return {
    time(fn) {
      const t = performance.now()
      fn()
      const ms = performance.now() - t
      total += ms
      runs++
      worst = Math.max(worst, ms)
    },
    check() {
      expect(runs).toBeGreaterThan(0)
      expect(total / runs, 'mean ms a parse').toBeLessThan(5)
      expect(worst, 'slowest parse, ms').toBeLessThan(50)
    },
  }
}

describe('T-FUZZ-01: arbitrary JSON', () => {
  it('parseHeader (v1 and v2) throws only BadHeader, 5 ms a parse on average and none over 50 ms', () => {
    const cost = parseCost()
    forAll('T-FUZZ-01', (rng) => {
      const json = rng.bool() ? jsonValue(rng) : apply({ ...VALID_V2 }, { op: 'replace', at: rng.int(0, 99), value: jsonValue(rng, 3) }, rng)
      cost.time(() => {
        throwsOnly(() => parseHeader(json), BadHeader)
        throwsOnly(() => parseHeaderV2(json), BadHeader)
      })
    })
    cost.check()
  })
})

describe('T-FUZZ-02: 1–4 structural mutations of a valid header', () => {
  for (const [name, valid] of [['v1', VALID_V1], ['v2 standard', VALID_V2], ['v2 fips-140-3', VALID_V2_FIPS]] as const) {
    it(`${name}: rejected with BadHeader, or accepted only if nothing was dropped or coerced`, () => {
      expect(canonicalJson(parseHeader(structuredClone(valid)))).toBe(canonicalJson(valid))
      forAll(`T-FUZZ-02 ${name}`, (rng) => {
        let h: Record<string, unknown> = structuredClone(valid)
        for (let i = rng.int(1, 4); i > 0; i--) h = apply(h, mutation(rng), rng)
        let parsed: unknown
        try {
          parsed = parseHeader(h)
        } catch (e) {
          expect(e).toBeInstanceOf(BadHeader)
          return
        }
        expect(canonicalJson(parsed)).toBe(canonicalJson(h))
      })
    })
  }
})

describe('T-FUZZ-03: KDF floors and ceilings over the safe integer range', () => {
  const ints = (rng: Rng) => rng.pick([rng.int(-1000, 2_000_000), rng.int(-(2 ** 31), 2 ** 31), rng.pick([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0, 65535, 65536, 1048576, 1048577])])
  it('v1 and v2 argon2id: accepted iff 65,536 <= m <= 1,048,576 and 2 <= t <= 10', () => {
    forAll('T-FUZZ-03 argon2id', (rng) => {
      const memoryKiB = ints(rng)
      const passes = rng.int(-100, 1000)
      const ok = memoryKiB >= 65536 && memoryKiB <= 1048576 && passes >= 2 && passes <= 10
      for (const valid of [VALID_V1, VALID_V2]) {
        const run = () => parseHeader({ ...valid, kdf: { ...valid.kdf, memoryKiB, passes } })
        if (ok) expect(run).not.toThrow()
        else expect(run).toThrow(BadHeader)
      }
    })
  })
  it('v2 pbkdf2: accepted iff 600,000 <= c <= 10,000,000', () => {
    forAll('T-FUZZ-03 pbkdf2', (rng) => {
      const iterations = rng.pick([rng.int(0, 20_000_000), rng.int(-(2 ** 31), 2 ** 31), rng.pick([599_999, 600_000, 10_000_000, 10_000_001])])
      const run = () => parseHeader({ ...VALID_V2_FIPS, kdf: { ...VALID_V2_FIPS.kdf, iterations } })
      if (iterations >= 600_000 && iterations <= 10_000_000) expect(run).not.toThrow()
      else expect(run).toThrow(BadHeader)
    })
  })
  it('v2 rule 2: the profile fixes the KDF', () => {
    expect(() => parseHeader({ ...VALID_V2, profile: 'fips-140-3' })).toThrow(BadHeader)
    expect(() => parseHeader({ ...VALID_V2_FIPS, profile: 'standard' })).toThrow(BadHeader)
  })
})

describe('T-FUZZ-04: canonicalJson', () => {
  it('orders keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = { '€': 1, '\r': 2, 'דּ': 3, '1': 4, '😀': 5, '\u0080': 6, 'ö': 7 }
    const order = ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'] as const
    expect(canonicalJson(input)).toBe('{' + order.map((k) => `${JSON.stringify(k)}:${input[k]}`).join(',') + '}')
  })
  it('matches an independent comparator (explicit code-unit compare) over random dictionaries', () => {
    const cmp = (a: string, b: string) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return a.charCodeAt(i) - b.charCodeAt(i)
      return a.length - b.length
    }
    forAll('T-FUZZ-04', (rng) => {
      const d: Record<string, number> = {}
      for (let i = rng.int(0, 8); i > 0; i--) d[rng.string(6)] = rng.int(-1000, 1000)
      const want = '{' + Object.keys(d).sort(cmp).map((k) => `${JSON.stringify(k)}:${d[k]}`).join(',') + '}'
      expect(canonicalJson(d)).toBe(want)
    })
  })
})

describe('T-FUZZ-10: the other local files, v1 and v2', () => {
  const lk2 = { format: 'slate-local-keys', version: 2, vaultId: VALID_V2.vaultId, deviceId: '00000000-0000-4000-8000-0000000000bb', profile: 'standard', keyEpoch: 0, db: 'slate-00000000.db', dbCipher: 'sqlcipher-4', nonce: b64(12), ct: b64(48) }
  const qu2 = { format: 'slate-quick-unlock', version: 2, vaultId: lk2.vaultId, deviceId: lk2.deviceId, keyEpoch: 0, sealedQu: b64(40), nonce: b64(12), ct: b64(48) }
  const pre2 = { themeId: 'builtin:light', motion: 'auto', systemTitleBar: false, idleMinutes: 15, lockOnSleep: true, lockOnScreenLock: true, quickUnlock: false, format: 'slate-preunlock', version: 2, profile: 'standard', mac: b64(32) }
  const floor = { format: 'slate-profile-floor', version: 1, vaultId: lk2.vaultId, profile: 'fips-140-3', minHeaderVersion: 2, mac: b64(32) }
  it('valid files parse', () => {
    expect(parseLocalKeys(lk2).bound.version).toBe(2)
    expect(parseQuickUnlock(qu2)).not.toBeNull()
    expect(parsePreunlockFile(pre2)?.profile).toBe('standard')
    expect(parseProfileFloor(floor)).toMatchObject({ profile: 'fips-140-3', minHeaderVersion: 2 })
  })
  it('mutations and arbitrary JSON: only their own error types, and no field outside the schema survives', () => {
    forAll('T-FUZZ-10', (rng) => {
      for (const [valid, parse] of [
        [lk2, (j: unknown) => parseLocalKeys(j).bound],
        [qu2, parseQuickUnlock],
        [pre2, (j: unknown) => parsePreunlockFile(j)?.content ?? null],
        [floor, parseProfileFloor],
      ] as const) {
        const input = rng.bool() ? jsonValue(rng, 3) : apply(structuredClone(valid) as Record<string, unknown>, mutation(rng))
        let out: unknown
        try {
          out = (parse as (j: unknown) => unknown)(input)
        } catch (e) {
          expect(e).toBeInstanceOf(BadLocalKeys)
          continue
        }
        if (out === null || typeof input !== 'object' || input === null) continue
        // An added key never parses: every v2 parser takes its exact field list.
        for (const k of Object.keys(input)) if (!Object.hasOwn(valid, k)) throw new Error(`accepted the extra field ${k}`)
      }
    })
  })
})

describe('T-FUZZ-11: decodeRecovery', () => {
  it('BadRecoveryKey or the right 32 bytes, never other bytes, for strings and near misses', () => {
    const key = randomBytes(32)
    const text = encodeRecovery(key)
    // C7: the module decodes into a handle; it holds `key` iff its KEK_rc equals HKDF over `key`.
    const holdsKey = (h: KeyHandle): boolean => {
      const n = vaultNative()
      const a = n.hkdfFromRecovery(h, new Uint8Array(0), 'slate/test/fuzz')
      const b = n.hkdfFromSecret(Uint8Array.from(key), new Uint8Array(0), 'slate/test/fuzz')
      try {
        return samePasswordKey(a, b)
      } finally {
        for (const k of [a, b, h]) n.keyDestroy(k)
      }
    }
    expect(holdsKey(decodeRecovery(secretBytes(text)))).toBe(true)
    forAll('T-FUZZ-11', (rng) => {
      let s = rng.bool() ? rng.string(80) : text
      if (s === text) {
        const i = rng.int(0, s.length - 1)
        s = rng.pick([s.slice(0, i) + s.slice(i + 1), s.slice(0, i) + rng.pick(['0', 'O', 'I', 'l', '-', ' ', 'z']) + s.slice(i + 1), s.toLowerCase(), s.replace(/-/g, ' '), s + 'A'])
      }
      let got: KeyHandle
      try {
        got = decodeRecovery(new TextEncoder().encode(s))
      } catch (e) {
        expect(e).toBeInstanceOf(BadRecoveryKey)
        return
      }
      expect(holdsKey(got)).toBe(true)
    })
  })
})

describe('T-FUZZ-12: decodeIdV2', () => {
  const mk = importKey(randomBytes(32), 'master')
  const keys = { enc: vaultNative().kbkdf(mk, 'slate/v2/name-enc', vidOf(VALID_V2.vaultId)), mac: vaultNative().kbkdf(mk, 'slate/v2/name-mac', vidOf(VALID_V2.vaultId)) }
  it('null for every random 64-hex string and every bit flip of a real name; real names decode; never throws', () => {
    const real = encodeIdV2(keys, 'page', '0f1e2d3c-4b5a-4968-8776-655443322110')
    expect(decodeIdV2(keys, real)).toEqual({ kind: 'page', uuid: '0f1e2d3c-4b5a-4968-8776-655443322110' })
    forAll('T-FUZZ-12', (rng) => {
      const random = Buffer.from(rng.bytes(32, 32)).toString('hex')
      expect(decodeIdV2(keys, random)).toBeNull()
      const bits = Buffer.from(real, 'hex')
      const bit = rng.int(0, 255)
      bits[bit >> 3]! ^= 1 << (bit & 7)
      expect(decodeIdV2(keys, bits.toString('hex'))).toBeNull()
      expect(decodeIdV2(keys, rng.string(70))).toBeNull()
    })
  })
})

// The same properties as fast-check properties (C11): fast-check shrinks a failure to its smallest input, which
// the seeded generators above cannot, and runs at the soak's scale at night (SLATE_FUZZ_RUNS). The seeded cases
// above stay: they carry the hand-made mutations (2^53, -0, 70,000 characters) the audit lists.
describe('T-FUZZ (fast-check): shrinking properties over the same parsers', () => {
  const T = fuzzTimeout()
  /** fast-check JSON plus the awkward numbers a hostile file holds, which `fc.jsonValue` never draws. */
  const hostileJson = fc.oneof(fc.jsonValue({ maxDepth: 6 }), fc.constantFrom<unknown>(-0, 2 ** 53, 1e21, 0.5, '', '\u0000', 'A'.repeat(70_000)))

  it('T-FUZZ-01: arbitrary JSON (fc.jsonValue, maxDepth 6): parseHeader and parseHeaderV2 throw only BadHeader, 5 ms a parse on average', () => {
    const cost = parseCost()
    fc.assert(
      fc.property(hostileJson, (json) => {
        cost.time(() => {
          throwsOnly(() => parseHeader(json), BadHeader)
          throwsOnly(() => parseHeaderV2(json), BadHeader)
        })
      }),
      fcParams,
    )
    cost.check()
  }, T)

  it('T-FUZZ-02: one field of a valid v2 header replaced by any JSON is refused, or accepted unchanged', () => {
    const keys = Object.keys(VALID_V2)
    fc.assert(
      fc.property(fc.constantFrom(...keys), hostileJson, (key, value) => {
        const h: Record<string, unknown> = { ...structuredClone(VALID_V2), [key]: value }
        let parsed: unknown
        try {
          parsed = parseHeader(h)
        } catch (e) {
          expect(e).toBeInstanceOf(BadHeader)
          return
        }
        expect(canonicalJson(parsed)).toBe(canonicalJson(h))
      }),
      fcParams,
    )
  }, T)

  it('T-FUZZ-03: argon2id accepted iff 65,536 <= m <= 1,048,576 and 2 <= t <= 10; pbkdf2 iff 600,000 <= c <= 10,000,000', () => {
    const edges = fc.constantFrom(65_535, 65_536, 1_048_576, 1_048_577, 599_999, 600_000, 10_000_000, 10_000_001)
    const anyInt = fc.oneof(fc.maxSafeInteger(), fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: 590_000, max: 10_010_000 }), edges)
    fc.assert(
      fc.property(anyInt, fc.integer({ min: -100, max: 1000 }), anyInt, (memoryKiB, passes, iterations) => {
        const argon = () => parseHeader({ ...VALID_V2, kdf: { ...VALID_V2.kdf, memoryKiB, passes } })
        if (memoryKiB >= 65536 && memoryKiB <= 1048576 && passes >= 2 && passes <= 10) expect(argon).not.toThrow()
        else expect(argon).toThrow(BadHeader)
        const pbkdf2 = () => parseHeader({ ...VALID_V2_FIPS, kdf: { ...VALID_V2_FIPS.kdf, iterations } })
        if (iterations >= 600_000 && iterations <= 10_000_000) expect(pbkdf2).not.toThrow()
        else expect(pbkdf2).toThrow(BadHeader)
      }),
      fcParams,
    )
  }, T)

  it('T-FUZZ-04: canonicalJson orders keys like an explicit code-unit comparator (fc.dictionary of binary strings)', () => {
    const cmp = (a: string, b: string) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return a.charCodeAt(i) - b.charCodeAt(i)
      return a.length - b.length
    }
    fc.assert(
      fc.property(fc.dictionary(fc.string({ unit: 'binary' }), fc.integer()), (d) => {
        const want = '{' + Object.keys(d).sort(cmp).map((k) => `${JSON.stringify(k)}:${String(d[k])}`).join(',') + '}'
        expect(canonicalJson(d)).toBe(want)
      }),
      fcParams,
    )
  }, T)

  it('T-FUZZ-05: parseEnvelope on fc.uint8Array (maxLength 512, half with a real magic) throws only UnverifiableFile', () => {
    const magic = fc.constantFrom([0x53, 0x4c, 0x45, 0x31], [0x53, 0x4c, 0x45, 0x32], [])
    fc.assert(
      fc.property(magic, fc.uint8Array({ maxLength: 512 }), (head, tail) => {
        throwsOnly(() => parseEnvelope(Uint8Array.from([...head, ...tail])), UnverifiableFile)
      }),
      fcParams,
    )
  }, T)

  it('T-FUZZ-08: 1–8 bit flips of a sealed SLE2 file give only UnverifiableFile', () => {
    const { key } = knownDataKey('slate/test/fuzz-fc')
    const keys = { syncKey: key, suite: SUITE.KBKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites }
    const path = 'docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000002.chunk'
    const sealed = sealEnvelope(keys, path, new TextEncoder().encode('a page of notes '.repeat(40)), { deflate: true, pad: true })
    try {
      fc.assert(
        fc.property(fc.uniqueArray(fc.nat(sealed.length * 8 - 1), { minLength: 1, maxLength: 8 }), (bits) => {
          const bad = Uint8Array.from(sealed)
          for (const bit of bits) bad[bit >> 3]! ^= 1 << (bit & 7)
          expect(() => openEnvelope(keys, path, bad)).toThrow(UnverifiableFile)
        }),
        { ...fcParams, numRuns: Math.max(300, Math.floor(fcParams.numRuns / 10)) },
      )
    } finally {
      vaultNative().keyDestroy(key)
    }
  }, T)

  it('T-FUZZ-11: decodeRecovery on fc.string() gives BadRecoveryKey or a key handle, never another error', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (s) => {
        let got: KeyHandle
        try {
          got = decodeRecovery(new TextEncoder().encode(s))
        } catch (e) {
          expect(e).toBeInstanceOf(BadRecoveryKey)
          return
        }
        // A random string that decodes is a valid recovery-key spelling; T-FUZZ-11 above checks which key it holds.
        vaultNative().keyDestroy(got)
      }),
      fcParams,
    )
  }, T)

  it('T-FUZZ-12: decodeIdV2 is null for fc.stringMatching(/^[0-9a-f]{64}$/) and any string, and never throws', () => {
    const mk = importKey(randomBytes(32), 'master')
    const keys = { enc: vaultNative().kbkdf(mk, 'slate/v2/name-enc', vidOf(VALID_V2.vaultId)), mac: vaultNative().kbkdf(mk, 'slate/v2/name-mac', vidOf(VALID_V2.vaultId)) }
    try {
      fc.assert(
        fc.property(fc.oneof(fc.stringMatching(/^[0-9a-f]{64}$/), fc.string({ maxLength: 80 })), (name) => {
          expect(decodeIdV2(keys, name)).toBeNull()
        }),
        fcParams,
      )
    } finally {
      for (const k of [keys.enc, keys.mac, mk]) vaultNative().keyDestroy(k)
    }
  }, T)
})
