// C5 criterion 1: the checked-in header-v2 JSON Schema (docs/compliance/schemas/vault-header-v2.schema.json)
// and parseHeaderV2 agree. A small JSON Schema 2020-12 interpreter for the keywords that schema uses reads
// the schema file itself, so a change to either side without the other fails here, on the T-FUZZ corpus.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, forAll, jsonValue, mutation } from '../../packages/desktop/test/fuzz'
import { BadHeader, parseHeaderV2 } from '../../packages/desktop/src/main/vault/header'
import { ROOT } from './repo'

type Schema = Record<string, unknown>
const schema = JSON.parse(readFileSync(join(ROOT, 'docs/compliance/schemas/vault-header-v2.schema.json'), 'utf8')) as Schema

const KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'type', 'additionalProperties', 'required', 'properties', 'const', 'enum', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'oneOf', '$ref', '$defs', 'maxItems', 'items'])

function equalJson(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equalJson(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equalJson((a as Schema)[k], (b as Schema)[k]))
  }
  return a === b
}

function valid(s: Schema, v: unknown): boolean {
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) throw new Error(`the schema uses ${k}, which this guard does not interpret`)
  if (typeof s.$ref === 'string') return valid((schema.$defs as Record<string, Schema>)[s.$ref.replace('#/$defs/', '')]!, v)
  if (Array.isArray(s.oneOf)) return (s.oneOf as Schema[]).filter((x) => valid(x, v)).length === 1
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
    if (s.items && !v.every((x) => valid(s.items as Schema, x))) return false
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Schema
    const props = (s.properties ?? {}) as Record<string, Schema>
    if (Array.isArray(s.required) && !s.required.every((k: string) => Object.hasOwn(o, k))) return false
    for (const k of Object.keys(o)) {
      if (Object.hasOwn(props, k)) {
        if (!valid(props[k]!, o[k])) return false
      } else if (s.additionalProperties === false) return false
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

function accepts(doc: unknown): boolean {
  try {
    parseHeaderV2(doc)
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
