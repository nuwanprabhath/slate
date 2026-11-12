// T-FUZZ (audit §6.4) against the v1 and v2 parsers: only each parser's own error, nothing silently dropped
// or coerced, KDF bounds over the whole integer range, RFC 8785 key order, and SIV names that decode only when
// they are ours. Deterministic: seed 0x51a7e, 2000 runs (test/fuzz.ts).
import { randomBytes } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { apply, fcParams, FUZZ_RUNS, forAll, fuzzTimeout, jsonValue, mutation, relativeCost, Rng, type Mutation } from '../../../test/fuzz'
import { importKey, knownDataKey, samePasswordKey } from '../../../test/vaultKeys'
import { openEnvelope, parseEnvelope, sealEnvelope, UnverifiableFile } from './envelope'
import { PROFILES } from './profile'
import { SUITE } from './suite'
import type { KeyHandle } from '@slate/native'
import { secretBytes } from '../../shared/secret'
import { BadHeader, buildHeaderV3From, canonicalJson, createVault, parseHeader, parseHeaderV2, scheduleOf, unlockWithRecovery, WrongSecret, type VaultHeaderV3 } from './header'
import { deriveSubkey } from './keyring'
import { parseLocalKeys, BadLocalKeys } from './localKeys'
import { decodeIdV2, encodeIdV2 } from './names'
import { destroyKey, toBase64, utf8, vaultNative } from './native'
import { parsePreunlockFile } from './preunlock'
import { parseProfileFloor } from './profileFloor'
import { parseQuickUnlock } from './quickUnlock'
import { BadRecoveryKey, decodeRecovery, encodeRecovery } from './recovery'
import { vidOf } from './suite'

// Every test here scales with SLATE_FUZZ_RUNS, the seeded ones too: the soak's 200,000 runs outlast vitest's 5 s
// default, and a --testTimeout given through `npm run test:main --` is taken by npm, not vitest.
vi.setConfig({ testTimeout: fuzzTimeout() })

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
 * The parse-time bound of T-FUZZ-01, relative to a benign parse measured in the same run. The property is that a
 * hostile input cannot cost disproportionately more than a well-formed header of the same shape through the same two
 * parsers, which is what a parse-time denial of service would mean. The old absolute ceilings (mean < 5 ms, worst
 * < 50 ms) measured the machine instead: on a 10-core Mac the worst parse reached 52-76 ms at load average 25-40 with
 * no bug behind it, while a benign parse costs about 0.01 ms, so `mean < 5 ms` would have sat still through a 400x
 * parse regression. `calibrate` times `benign` CALIBRATION_RUNS times and drops the first CALIBRATION_WARMUP, so JIT
 * warm-up cannot inflate the baseline - an inflated baseline would loosen the guard.
 *
 * Measured mean-over-benign, 10 samples on a quiet 10-core Mac: 2.20, 1.83, 2.92, 2.86, 2.36, 2.25, 1.99, 2.81,
 * 2.75, 0.64; 8 samples under 12 CPU spinners (load average 19-22): 2.95, 5.49, 4.79, 2.86, 2.31, 2.73, 6.42, 3.11.
 * Load does not cancel entirely - it roughly doubles the spread, because the hostile phase draws 2000 samples and the
 * baseline is one mean - so MEAN_OVER_BENIGN is 20, about 3x the observed 6.42 and still some 25x tighter than the
 * 5 ms it replaces. That is loose enough to survive a loaded machine and tight enough to catch a super-linear parse:
 * a well-formedness pass quadratic in string length and nesting depth measures 97 (see the commit message).
 *
 * P99_OVER_BENIGN bounds the slow tail, for a parser slow on one input class rather than on average: observed
 * 1.6-16.8 over the runs above and 59.1 once on a machine shared with other agents, so 150. The single slowest parse
 * gets no relative bound, because it is one sample and the scheduler owns it - the benign maximum alone ranged from
 * 13x to 1286x the benign mean across these runs, so any multiple honest about that noise would assert nothing.
 * ABSOLUTE_CEILING_MS is its deliberately generous bound, kept so the guard still fails if the calibration itself
 * degrades (both parsers slowing together keeps every ratio flat).
 */
const CALIBRATION_RUNS = 2000
const CALIBRATION_WARMUP = 20
const MEAN_OVER_BENIGN = 20
const P99_OVER_BENIGN = 150
const MEAN_CEILING_MS = 5
const ABSOLUTE_CEILING_MS = 500

const parseCost = (benign: () => void) =>
  relativeCost(benign, {
    meanOverBenign: MEAN_OVER_BENIGN,
    p99OverBenign: P99_OVER_BENIGN,
    meanCeilingMs: MEAN_CEILING_MS,
    absoluteCeilingMs: ABSOLUTE_CEILING_MS,
    calibrationRuns: CALIBRATION_RUNS,
    calibrationWarmup: CALIBRATION_WARMUP,
  })

/** The benign baseline: a valid v2 header through the same two parsers, timed the same way. */
const benignParse = (): void => {
  throwsOnly(() => parseHeader(VALID_V2), BadHeader)
  throwsOnly(() => parseHeaderV2(VALID_V2), BadHeader)
}

describe('T-FUZZ-01: arbitrary JSON', () => {
  it('parseHeader (v1 and v2) throws only BadHeader, and costs no more than a benign parse in proportion', () => {
    const cost = parseCost(benignParse)
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
    expect(holdsKey(decodeRecovery(text))).toBe(true)
    // The mutations below are text edits, so the fuzzer works on the key's text form.
    const textForm = new TextDecoder().decode(text)
    forAll('T-FUZZ-11', (rng) => {
      let s = rng.bool() ? rng.string(80) : textForm
      if (s === textForm) {
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

  it('T-FUZZ-01: arbitrary JSON (fc.jsonValue, maxDepth 6): parseHeader and parseHeaderV2 throw only BadHeader, in proportion to a benign parse', () => {
    const cost = parseCost(benignParse)
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

// PQ-B1 (roadmap §3.2-§3.3): a real v3 header with one hybrid device slot, mutated at any depth (device slot fields
// included), then parsed and, when it parses, opened with the vault's own recovery key.
describe('T-PQ-B1-08: mutated v3 headers', () => {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

  /** `mutation` applied to any object in the header (the root, wraps, a device slot, pq, a history entry). */
  function applyAnywhere(doc: Record<string, unknown>, m: Mutation, rng: Rng): Record<string, unknown> {
    const out = structuredClone(doc)
    const targets: Record<string, unknown>[] = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (isObj(v)) {
        targets.push(v)
        Object.values(v).forEach(walk)
      }
    }
    walk(out)
    const target = rng.pick(targets)
    const keys = Object.keys(target)
    if (m.op === 'delete' && keys.length) delete target[keys[m.at % keys.length]!]
    if (m.op === 'add') target[m.key] = m.value
    if (m.op === 'replace' && keys.length) target[keys[m.at % keys.length]!] = m.value
    return out
  }

  it('T-PQ-B1-08: 10,000 mutated v3 headers never throw anything but BadHeader or WrongSecret', async () => {
    const weak = { allowWeakForTests: true }
    const made = await createVault({ password: secretBytes('a fuzzed v3 vault'), kdf: { memoryKiB: 64, passes: 1 } }, weak)
    const v3 = structuredClone(buildHeaderV3From(made.header, made.mk)) as VaultHeaderV3 & { wraps: Record<string, unknown> }
    v3.wraps['device-11111111-1111-4111-8111-111111111111'] = {
      alg: 'mlkem768-x25519-kdf56c',
      pkHash: b64(32, 3),
      kemCt: b64(1088, 4),
      ecdhPub: b64(32, 5),
      nonce: b64(12, 6),
      ct: b64(48, 7),
      addedAt: 1761200000000,
      addedBy: '22222222-2222-4222-8222-222222222222',
    }
    v3.pq.minCapability = 2
    const { check: _drop, ...rest } = v3
    const kCheck = deriveSubkey(made.mk, 'check', scheduleOf(v3))
    const valid = { ...rest, check: toBase64(vaultNative().hmacSha256(kCheck, utf8(canonicalJson(rest)))) } as Record<string, unknown>
    destroyKey(kCheck)
    destroyKey(made.mk)
    const recovery = made.recoveryKey!
    destroyKey(unlockWithRecovery(parseHeader(structuredClone(valid), weak), recovery))

    let parsed = 0
    let opened = 0
    forAll(
      'T-PQ-B1-08',
      (rng) => {
        let h = structuredClone(valid)
        for (let i = rng.int(1, 4); i > 0; i--) h = applyAnywhere(h, mutation(rng), rng)
        let header
        try {
          header = parseHeader(h, weak)
        } catch (e) {
          expect(e).toBeInstanceOf(BadHeader)
          return
        }
        parsed++
        // Nothing dropped or coerced: what parses is the input, field for field.
        expect(canonicalJson(header)).toBe(canonicalJson(h))
        try {
          destroyKey(unlockWithRecovery(header, recovery))
          opened++
        } catch (e) {
          expect(e).toBeInstanceOf(WrongSecret)
        }
      },
      Math.max(10_000, FUZZ_RUNS),
    )
    // Both answers are exercised, or the property would prove nothing.
    expect(parsed).toBeGreaterThan(50)
    expect(parsed - opened).toBeGreaterThan(20)
  }, fuzzTimeout(10_000))
})
