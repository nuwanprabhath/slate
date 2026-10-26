import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { allowlistEntries, baseCommit, read, readAt, ROOT } from './repo'

/**
 * The exception lists only shrink. Compared with the branch's base (`merge-base HEAD
 * ${SLATE_BASE_REF:-main}`): an allowlist may lose entries, never gain one, and
 * eslint-suppressions.json may lose suppressions, never gain one. A new violation is fixed, not
 * listed. If the accepted path truly cannot work, stop and report it under "Guardrail conflicts"
 * for the maintainer; only they grow a list.
 *
 * dependencies.json is not an exception list but the approval record for dependencies; it may grow,
 * and tools/guards/ being a security-sensitive path puts each addition in front of a reviewer.
 */
const APPROVAL_LISTS = new Set(['dependencies'])
const base = baseCommit()

type Suppressions = Record<string, Record<string, { count: number }>>

export function grownSuppressions(before: Suppressions, after: Suppressions): string[] {
  const grown: string[] = []
  for (const [file, rules] of Object.entries(after)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      const was = before[file]?.[rule]?.count ?? 0
      if (count > was) grown.push(`${file}: ${rule} ${String(was)} → ${String(count)}`)
    }
  }
  return grown
}

type Entries = Record<string, { names: string[] }>

/** New keys, and new names inside an existing key (a new import in a file allowlisted for another). */
export function addedKeys(before: Entries, after: Entries): string[] {
  return Object.entries(after).flatMap(([k, { names }]) => {
    const was = before[k]
    if (!was) return [k]
    return names.filter((n) => !was.names.includes(n)).map((n) => `${k} (${n})`)
  })
}

describe('ratchet: exception lists only shrink', () => {
  // Outside a checkout with history (a source tarball) there is no base to compare with.
  it.skipIf(base === null)('no allowlist gained an entry since the base', () => {
    const added: string[] = []
    for (const file of readdirSync(join(ROOT, 'tools/guards/allowlists')).filter((f) => f.endsWith('.json'))) {
      const name = file.slice(0, -5)
      if (APPROVAL_LISTS.has(name)) continue
      const was = readAt(base!, `tools/guards/allowlists/${file}`)
      if (was === null) continue // introduced on this branch: its first contents are the baseline
      for (const key of addedKeys(allowlistEntries(name, was), allowlistEntries(name))) added.push(`${file}: ${key}`)
    }
    expect(
      added.map((a) => `${a} was added; fix the code instead. If the accepted path cannot work, report it under "Guardrail conflicts": only the maintainer grows an allowlist`),
    ).toEqual([])
  })

  // As above: no base to compare with.
  it.skipIf(base === null)('eslint-suppressions.json gained no suppression since the base', () => {
    const was = readAt(base!, 'eslint-suppressions.json')
    if (was === null) return
    const grown = grownSuppressions(JSON.parse(was) as Suppressions, JSON.parse(read('eslint-suppressions.json')) as Suppressions)
    expect(grown.map((g) => `${g}: fix the new violation (the message names the accepted path); never --suppress-all or --suppress-rule`)).toEqual([])
  })

  it('the comparisons catch growth (self-test)', () => {
    const e = (...names: string[]) => ({ names })
    expect(addedKeys({ a: e() }, { a: e(), b: e() })).toEqual(['b'])
    expect(addedKeys({ a: e(), b: e() }, { a: e() })).toEqual([])
    expect(addedKeys({ a: e('createHash') }, { a: e('createHash', 'createCipheriv') })).toEqual(['a (createCipheriv)'])
    expect(grownSuppressions({ f: { r: { count: 2 } } }, { f: { r: { count: 3 } }, g: { r: { count: 1 } } })).toEqual(['f: r 2 → 3', 'g: r 0 → 1'])
    expect(grownSuppressions({ f: { r: { count: 2 } } }, { f: { r: { count: 1 } } })).toEqual([])
  })
})
