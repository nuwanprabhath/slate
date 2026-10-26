import { describe, expect, it } from 'vitest'
import { isTestFile, read, walk } from './repo'

/**
 * Audit §4.8 (AU-2 / AU-3): every security event is emitted by exactly one function,
 * `securityEvent.<name>` in packages/desktop/src/main/log/securityEvents.ts, so its fields cannot drift between
 * call sites and no call site can add a secret to it. The event's name is a string literal in that file and in
 * no other. To add an event: add its row to audit §4.8, then its emitter there, and call the emitter.
 */
const EMITTERS = 'packages/desktop/src/main/log/securityEvents.ts'
const MAIN_PROCESS = ['packages/desktop/src/main', 'packages/sync/src', 'packages/mcp/src', 'packages/importer/src']
const sources = MAIN_PROCESS.flatMap((d) => walk(d, ['.ts'])).filter((f) => !isTestFile(f))
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The event names in §4.8's table, first column (a cell may list two, `a` / `b`). */
export function auditEvents(audit: string): string[] {
  const section = audit.slice(audit.indexOf('### 4.8 Security audit events'), audit.indexOf('### 4.9'))
  const names: string[] = []
  for (const row of section.split('\n').filter((l) => l.startsWith('| `'))) {
    const cell = row.split('|')[1] ?? ''
    for (const m of cell.matchAll(/`([a-z]+(?:\.[a-z-]+)+)`/g)) names.push(m[1]!)
  }
  return names
}

/** `emitter name -> event name` for each entry of the `securityEvent` object (an entry may span lines). */
export function emittersOf(file: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of file.matchAll(/^ {2}(\w+): \([\s\S]*?\.(?:info|warn|error)\('([a-z]+(?:\.[a-z-]+)+)'/gm)) out.set(m[1]!, m[2]!)
  return out
}

// Emitters whose subject is another work package's; each leaves this list in the commit that calls it
// (the test below fails once it is called, so the list only shrinks).
const NOT_YET_CALLED: Record<string, string> = {
  syncUnverifiable: 'sync: the SLE2 reader that counts unverifiable remote files (T-POL-07)',
}

describe('security audit events (§4.8)', () => {
  const audit = auditEvents(read('docs/reviews/compliance_audit.md'))
  const emitters = emittersOf(read(EMITTERS))
  const text = new Map(sources.map((f) => [f, strip(read(f))]))

  it('reads the event list from the audit (self-test)', () => {
    expect(audit).toContain('vault.unlock.succeeded')
    expect(audit).toContain('vault.recovery.rotated')
    expect(audit.length).toBeGreaterThanOrEqual(18)
  })

  it('every §4.8 event has an emitter, and the emitters are exactly the audit list', () => {
    expect([...emitters.values()].sort()).toEqual([...audit].sort())
  })

  it('each event name is a string literal in securityEvents.ts and nowhere else in main', () => {
    const problems: string[] = []
    for (const name of audit) {
      const where = sources.filter((f) => new RegExp(`['"\`]${name.replace(/[.]/g, '\\.')}['"\`]`).test(text.get(f)!))
      if (where.length !== 1 || where[0] !== EMITTERS) problems.push(`${name}: found in ${where.join(', ') || 'no file'}; emit it through securityEvent in ${EMITTERS}`)
      const count = (text.get(EMITTERS)!.match(new RegExp(`'${name.replace(/[.]/g, '\\.')}'`, 'g')) ?? []).length
      if (count !== 1) problems.push(`${name}: ${count} emitters in ${EMITTERS}, expected exactly one`)
    }
    expect(problems).toEqual([])
  })

  it('every emitter is called, except the ones that belong to a work package still to come', () => {
    const others = sources.filter((f) => f !== EMITTERS).map((f) => text.get(f)!).join('\n')
    const called = (name: string): boolean => new RegExp(`securityEvent\\.${name}\\(`).test(others)
    const uncalled = [...emitters.keys()].filter((e) => !called(e) && !(e in NOT_YET_CALLED))
    expect(uncalled.map((e) => `${e} is never called: emit it where it happens, or add it to NOT_YET_CALLED with the work package that will`)).toEqual([])
    const stale = Object.keys(NOT_YET_CALLED).filter((e) => called(e) || !emitters.has(e))
    expect(stale.map((e) => `${e} is called now (or gone): remove it from NOT_YET_CALLED`)).toEqual([])
  })

  it('the parsers read what they are meant to (self-test)', () => {
    const file = "export const securityEvent = {\n  a: (f: X, to: Info = app()): void => to.info('x.one', f),\n  b: (f: Y, scope = 'app'): void =>\n    scoped(scope).warn('x.two-b', f),\n} as const"
    expect([...emittersOf(file)]).toEqual([['a', 'x.one'], ['b', 'x.two-b']])
    expect(auditEvents('### 4.8 Security audit events\n| `a.b` / `c.d-e` | f |\n| Event | Fields |\n### 4.9')).toEqual(['a.b', 'c.d-e'])
  })
})
