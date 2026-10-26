import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script with no declarations
import { OSCAL_VERSION, SCHEMA_SHA256, checkPinned, validate } from '../../../../scripts/validate-oscal.mjs'

const doc = JSON.parse(readFileSync(join(__dirname, '../../../../docs/compliance/oscal/slate-component-definition.json'), 'utf8')) as {
  'component-definition': { uuid: string; metadata: { 'oscal-version': string }; components: Array<{ 'control-implementations'?: Array<{ 'implemented-requirements': Array<{ uuid: string; 'control-id': string }> }> }> }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('OSCAL component definition (the schema check itself runs in .github/workflows/compliance.yml)', () => {
  it('the schema is pinned by a SHA-256 and anything else is refused', () => {
    expect(SCHEMA_SHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(() => checkPinned(Buffer.from('{"not":"the schema"}'))).toThrow(/not the pinned/)
  })

  it('the document names the pinned OSCAL version and keeps stable, unique version-4 UUIDs', () => {
    const def = doc['component-definition']
    expect(def.metadata['oscal-version']).toBe(OSCAL_VERSION)
    const uuids = [...JSON.stringify(doc).matchAll(/"uuid":"([^"]+)"/g)].map((m) => m[1] ?? "")
    expect(uuids.length).toBeGreaterThan(10)
    for (const u of uuids) expect(u, u).toMatch(UUID)
    expect(new Set(uuids).size).toBe(uuids.length)
  })

  it('every control the audit assigns to C10 has an implementation statement', () => {
    const ids = doc['component-definition'].components.flatMap((c) => c['control-implementations']?.flatMap((i) => i['implemented-requirements'].map((r) => r['control-id'])) ?? [])
    for (const c of ['ac-7', 'ac-11', 'ia-5.1', 'sc-12', 'sc-8', 'sc-8.1']) expect(ids, c).toContain(c)
  })

  it('names only tests that exist, and a statement whose work package has not landed says so in its remarks (review C10)', () => {
    const text = JSON.stringify(doc)
    const ids = [...new Set(text.match(/\bT-[A-Z]+-\d+\b/g) ?? [])]
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.name === 'node_modules' || d.name === 'out' || d.name.startsWith('.')) continue
        const p = join(dir, d.name)
        if (d.isDirectory()) walk(p)
        else if (/\.(test|spec)\.tsx?$/.test(d.name)) files.push(p)
      }
    }
    walk(join(__dirname, '../../../..', 'packages'))
    walk(join(__dirname, '../../../..', 'tools'))
    const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(ids.filter((id) => !corpus.includes(id))).toEqual([])
    // Statements that describe a work package not yet merged; each leaves this list when its package lands.
    const unmerged: Record<string, string> = { 'si-6': 'C6' }
    const byControl = new Map(doc['component-definition'].components.flatMap((c) => c['control-implementations']?.flatMap((i) => i['implemented-requirements']) ?? []).map((r) => [r['control-id'], r as { remarks?: string }]))
    for (const [control, wp] of Object.entries(unmerged)) expect(byControl.get(control)?.remarks ?? '', control).toContain(wp)
  })

  it('validation reports a document the schema rejects', () => {
    const schema = { type: 'object', required: ['component-definition'], properties: { 'component-definition': { type: 'object', required: ['uuid'] } } }
    expect(validate(schema, doc)).toEqual([])
    expect(validate(schema, { 'component-definition': {} }).length).toBeGreaterThan(0)
  })
})
