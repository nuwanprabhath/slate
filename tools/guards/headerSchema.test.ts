// C5 criterion 1: the checked-in header-v2 JSON Schema (docs/compliance/schemas/vault-header-v2.schema.json)
// and parseHeaderV2 agree; PQ-B1: so do vault-header-v3.schema.json and parseHeaderV3. A small JSON Schema
// 2020-12 interpreter for the keywords those schemas use reads the schema files themselves, so a change to
// either side without the other fails here, on the T-FUZZ corpus.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, forAll, jsonValue, mutation, type Mutation, type Rng } from '../../packages/desktop/test/fuzz'
import { BadHeader, parseHeaderV2, parseHeaderV3 } from '../../packages/desktop/src/main/vault/header'
import { ROOT } from './repo'

type Schema = Record<string, unknown>
const loadSchema = (name: string) => JSON.parse(readFileSync(join(ROOT, 'docs/compliance/schemas', name), 'utf8')) as Schema
const schema = loadSchema('vault-header-v2.schema.json')
const schemaV3 = loadSchema('vault-header-v3.schema.json')

const KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'additionalProperties', 'required', 'properties', 'const', 'enum', 'pattern', 'minimum',
  'maximum', 'minLength', 'maxLength', 'oneOf', '$ref', '$defs', 'maxItems', 'items', 'allOf', 'maxProperties', 'patternProperties',
])

function equalJson(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equalJson(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equalJson((a as Schema)[k], (b as Schema)[k]))
  }
  return a === b
}

/** Whether `v` is valid against `s`, a subschema of `root` (where its `$ref`s point). */
function valid(s: Schema, v: unknown, root: Schema = schema): boolean {
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) throw new Error(`the schema uses ${k}, which this guard does not interpret`)
  if (typeof s.$ref === 'string') return valid((root.$defs as Record<string, Schema>)[s.$ref.replace('#/$defs/', '')]!, v, root)
  if (Array.isArray(s.oneOf)) return (s.oneOf as Schema[]).filter((x) => valid(x, v, root)).length === 1
  if (Array.isArray(s.allOf) && !(s.allOf as Schema[]).every((x) => valid(x, v, root))) return false
  if (Object.hasOwn(s, 'const') && !equalJson(s.const, v)) return false
  if (Array.isArray(s.enum) && !s.enum.some((e) => equalJson(e, v))) return false
  if (s.type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) return false
  if (s.type === 'array' && !Array.isArray(v)) return false
  if (s.type === 'string' && typeof v !== 'string') return false
  if (s.type === 'integer' && !(typeof v === 'number' && Number.isInteger(v))) return false
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) return false
    if (typeof s.maximum === 'number' && v > s.maximum) return false
  }
  if (typeof v === 'string') {
    const len = [...v].length
    if (typeof s.minLength === 'number' && len < s.minLength) return false
    if (typeof s.maxLength === 'number' && len > s.maxLength) return false
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) return false
  }
  if (Array.isArray(v)) {
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) return false
    if (s.items && !v.every((x) => valid(s.items as Schema, x, root))) return false
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Schema
    const props = (s.properties ?? {}) as Record<string, Schema>
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>)
    if (Array.isArray(s.required) && !s.required.every((k: string) => Object.hasOwn(o, k))) return false
    if (typeof s.maxProperties === 'number' && Object.keys(o).length > s.maxProperties) return false
    for (const k of Object.keys(o)) {
      const matched = patterns.filter(([re]) => new RegExp(re, 'u').test(k))
      if (Object.hasOwn(props, k) && !valid(props[k]!, o[k], root)) return false
      if (!matched.every(([, sub]) => valid(sub, o[k], root))) return false
      if (!Object.hasOwn(props, k) && matched.length === 0 && s.additionalProperties === false) return false
    }
  }
  return true
}

/** Semantic rules 1–3 of audit §4.5.2, written from the audit's text, independently of header.ts. */
function semantic(h: Schema): boolean {
  const kdf = h.kdf as Schema
  const salt = Buffer.from(kdf.salt as string, 'base64')
  if (salt.toString('base64') !== kdf.salt || salt.length < 16 || salt.length > 64) return false
  if ((h.profile === 'fips-140-3') !== (kdf.alg === 'pbkdf2-hmac-sha512')) return false
  const epochs = ((h.history ?? []) as Schema[]).map((e) => e.epoch as number)
  return new Set(epochs).size === epochs.length && epochs.every((e) => e < (h.keyEpoch as number))
}

/**
 * Roadmap §3.3 rules 5–8 for v3, and §3.2's cap of 16 device slots (rules 1–3 as v2; rule 4, 64 KiB, cannot fail for a schema-valid header: 18 wraps
 * of at most about 2.5 KiB), written from the roadmap's text, independently of header.ts.
 */
function semanticV3(h: Schema): boolean {
  if (!semantic(h)) return false
  const pq = h.pq as Schema
  if (pq.kem !== 'hybrid-only') return false
  const slots = Object.entries(h.wraps as Schema).filter(([k]) => k.startsWith('device-')).map(([, s]) => s as Schema)
  if (slots.length > 16) return false
  if (slots.length > 0 && (pq.minCapability as number) < 2) return false
  const sizes: Record<string, [number, number]> = { 'mlkem768-x25519-kdf56c': [1088, 32], 'mlkem1024-p384-kdf56c': [1568, 97] }
  for (const s of slots) {
    const kemCt = Buffer.from(s.kemCt as string, 'base64')
    const pub = Buffer.from(s.ecdhPub as string, 'base64')
    if (kemCt.toString('base64') !== s.kemCt || pub.toString('base64') !== s.ecdhPub) return false
    const [kemLen, pubLen] = sizes[s.alg as string]!
    if (kemCt.length !== kemLen || pub.length !== pubLen) return false
    if (s.alg === 'mlkem1024-p384-kdf56c' && pub[0] !== 0x04) return false
    if (h.profile === 'fips-140-3' && s.alg !== 'mlkem1024-p384-kdf56c') return false
  }
  return true
}

function accepts(doc: unknown, parse: (d: unknown) => unknown = parseHeaderV2): boolean {
  try {
    parse(doc)
    return true
  } catch (e) {
    if (!(e instanceof BadHeader)) throw e
    return false
  }
}

const b64 = (n: number, fill = 7) => Buffer.alloc(n, fill).toString('base64')
const wrap = () => ({ alg: 'aes-256-gcm', nonce: b64(12, 1), ct: b64(48, 2) })
const BASE = {
  format: 'slate-vault',
  version: 2,
  vaultId: '00000000-0000-4000-8000-0000000000aa',
  revision: 3,
  createdAt: 1761200000000,
  profile: 'standard',
  suite: 2,
  keyEpoch: 2,
  kdf: { alg: 'argon2id', memoryKiB: 262144, passes: 4, parallelism: 1, salt: b64(16) },
  wraps: { password: wrap(), recovery: wrap() },
  history: [{ epoch: 0, ...wrap() }],
  check: b64(32, 0),
}
const FIPS = { ...BASE, profile: 'fips-140-3', kdf: { alg: 'pbkdf2-hmac-sha512', iterations: 600000, salt: b64(32) } }

describe('C5 criterion 1: vault-header-v2.schema.json and parseHeaderV2 agree', () => {
  it('both accept the valid headers', () => {
    for (const doc of [BASE, FIPS]) {
      expect(valid(schema, doc)).toBe(true)
      expect(accepts(doc)).toBe(true)
    }
  })

  it('parseHeaderV2 accepts a document iff the schema does and semantic rules 1–3 hold, over the fuzz corpus', () => {
    let accepted = 0
    forAll('header schema agreement', (rng) => {
      let doc: unknown = rng.pick([BASE, FIPS])
      if (rng.next() < 0.1) doc = jsonValue(rng)
      else for (let i = rng.int(1, 3); i > 0; i--) doc = apply(doc as Record<string, unknown>, mutation(rng), rng)
      const want = valid(schema, doc) && semantic(doc as Schema)
      expect(accepts(doc), JSON.stringify(doc).slice(0, 300)).toBe(want)
      if (want) accepted++
    })
    // The corpus must exercise both answers, or agreement would prove nothing.
    expect(accepted).toBeGreaterThan(20)
  })

  it('the guard notices a disagreement: a schema without the check pattern accepts what the parser refuses', () => {
    const loose = { ...BASE, check: b64(31) + 'AA' }
    expect(accepts(loose)).toBe(false)
    expect(valid({ ...schema, properties: { ...(schema.properties as Schema), check: { type: 'string' } } }, loose)).toBe(true)
  })
})

const DEVICE = 'device-11111111-1111-4111-8111-111111111111'
const p384 = (lead = 4) => Buffer.concat([Buffer.of(lead), Buffer.alloc(96, 9)]).toString('base64')
const slot768 = { alg: 'mlkem768-x25519-kdf56c', pkHash: b64(32, 3), kemCt: b64(1088, 4), ecdhPub: b64(32, 5), nonce: b64(12, 6), ct: b64(48, 7), addedAt: 1761200000000, addedBy: '22222222-2222-4222-8222-222222222222' }
const slot1024 = { ...slot768, alg: 'mlkem1024-p384-kdf56c', kemCt: b64(1568, 4), ecdhPub: p384() }
const V3 = { ...BASE, version: 3, pq: { kem: 'hybrid-only', minCapability: 1 } }
const V3_SLOT = { ...V3, wraps: { ...BASE.wraps, [DEVICE]: slot768 }, pq: { kem: 'hybrid-only', minCapability: 2 } }
const V3_FIPS = { ...FIPS, version: 3, wraps: { ...FIPS.wraps, [DEVICE]: slot1024 }, pq: { kem: 'hybrid-only', minCapability: 2 } }
/** Refused by rule 8 alone: a near miss on its alg (to mlkem1024) still fails rule 7, so only rule 8 decides it. */
const V3_FIPS_768 = { ...V3_FIPS, wraps: { ...FIPS.wraps, [DEVICE]: slot768 } }

/** Values a device slot field or `pq` nearly takes: the wrong size for the other algorithm, a stray bit, a compressed point. */
const NEAR_MISSES: unknown[] = [
  ...[0, 31, 32, 33, 44, 96, 97, 98, 1087, 1088, 1089, 1567, 1568, 1569].map((n) => b64(n, 4)),
  p384(2),
  p384(3),
  p384(4),
  b64(1088, 4).slice(0, -2) + 'F=',
  b64(1568, 4).slice(0, -2) + 'F=',
  b64(32, 5).slice(0, -2) + 'B=',
  'mlkem768-x25519-kdf56c',
  'mlkem1024-p384-kdf56c',
  'x25519-kdf56c',
  'hybrid-only',
  'classical',
  -1,
  0,
  1,
  2,
  255,
  256,
  1.5,
  '00000000-0000-4000-8000-0000000000aa',
]
const nearMiss = (rng: Rng): unknown => rng.pick(NEAR_MISSES)

/** `mutation` (or a near miss) at any depth: the root, wraps, a device slot, pq or a history entry. */
function applyAnywhere(doc: Record<string, unknown>, m: Mutation, rng: Rng): Record<string, unknown> {
  const out = structuredClone(doc)
  const targets: Record<string, unknown>[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      targets.push(v as Record<string, unknown>)
      Object.values(v).forEach(walk)
    }
  }
  walk(out)
  // Most near misses land in a device slot or `pq`, where rules 5–8 live.
  const pqParts = targets.filter((o) => o === out.pq || Object.hasOwn(o, 'kemCt'))
  const nearly = rng.next() < 0.4 && pqParts.length > 0
  const target = nearly ? rng.pick(pqParts) : rng.pick(targets)
  const keys = Object.keys(target)
  if (nearly && keys.length) target[rng.pick(keys)] = nearMiss(rng)
  else if (m.op === 'delete' && keys.length) delete target[keys[m.at % keys.length]!]
  else if (m.op === 'add') target[m.key] = m.value
  else if (m.op === 'replace' && keys.length) target[keys[m.at % keys.length]!] = m.value
  return out
}

describe('PQ-B1: vault-header-v3.schema.json and parseHeaderV3 agree', () => {
  const acceptsV3 = (doc: unknown) => accepts(doc, parseHeaderV3)

  it('the v3 schema inlines the v2 kdf, salt, wrap and history definitions verbatim', () => {
    expect((schemaV3.properties as Schema).kdf).toEqual((schema.properties as Schema).kdf)
    for (const d of ['salt', 'wrap', 'history']) expect((schemaV3.$defs as Schema)[d], d).toEqual((schema.$defs as Schema)[d])
  })

  it('both accept the valid v3 headers', () => {
    for (const doc of [V3, V3_SLOT, V3_FIPS]) {
      expect(valid(schemaV3, doc, schemaV3)).toBe(true)
      expect(acceptsV3(doc)).toBe(true)
    }
  })

  it('parseHeaderV3 accepts a document iff the schema does and rules 1–8 hold, over the fuzz corpus', () => {
    let accepted = 0
    let refused = 0
    forAll('header v3 schema agreement', (rng) => {
      let doc: unknown = rng.pick([V3, V3_SLOT, V3_FIPS, V3_FIPS_768])
      if (rng.next() < 0.1) doc = jsonValue(rng)
      else for (let i = rng.int(1, 3); i > 0; i--) doc = rng.bool() ? apply(doc as Record<string, unknown>, mutation(rng), rng) : applyAnywhere(doc as Record<string, unknown>, mutation(rng), rng)
      const want = valid(schemaV3, doc, schemaV3) && semanticV3(doc as Schema)
      expect(acceptsV3(doc), JSON.stringify(doc).slice(0, 300)).toBe(want)
      if (want) accepted++
      else refused++
    })
    expect(accepted).toBeGreaterThan(20)
    expect(refused).toBeGreaterThan(20)
  })

  it('every near miss in every device slot and pq field: parseHeaderV3 accepts it iff the schema does and rules 1–8 hold', () => {
    let accepted = 0
    for (const base of [V3_SLOT, V3_FIPS, V3_FIPS_768]) {
      for (const field of [...Object.keys(slot768), 'pq.kem', 'pq.minCapability']) {
        for (const value of NEAR_MISSES) {
          const doc = structuredClone(base) as Schema & { wraps: Record<string, Schema>; pq: Schema }
          if (field.startsWith('pq.')) doc.pq[field.slice(3)] = value
          else doc.wraps[DEVICE]![field] = value
          const want = valid(schemaV3, doc, schemaV3) && semanticV3(doc)
          expect(acceptsV3(doc), `${field} = ${JSON.stringify(value).slice(0, 40)}`).toBe(want)
          if (want) accepted++
        }
      }
    }
    expect(accepted).toBeGreaterThan(10)
  })

  it('the guard notices a disagreement: a schema without maxProperties on wraps accepts what the parser refuses', () => {
    const wraps: Schema = { ...BASE.wraps }
    for (let i = 0; i < 17; i++) wraps[`device-${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`] = slot768
    const crowded = { ...V3_SLOT, wraps }
    expect(acceptsV3(crowded)).toBe(false)
    expect(valid(schemaV3, crowded, schemaV3)).toBe(false)
    // 17 slots and the password alone are 18 wraps: the schema accepts them, and only the 16-slot cap refuses them.
    const { recovery: _r, ...passwordOnly } = wraps
    expect(valid(schemaV3, { ...V3_SLOT, wraps: passwordOnly }, schemaV3)).toBe(true)
    expect(semanticV3({ ...V3_SLOT, wraps: passwordOnly })).toBe(false)
    expect(acceptsV3({ ...V3_SLOT, wraps: passwordOnly })).toBe(false)
    const props = schemaV3.properties as Schema
    const { maxProperties: _m, ...looseWraps } = props.wraps as Schema
    expect(valid({ ...schemaV3, properties: { ...props, wraps: looseWraps } }, crowded, schemaV3)).toBe(true)
  })
})
