import { describe, expect, it } from 'vitest'
import { aliases, build, expand, mappingRows, OUT, PENDING_WPS, POAM, requiredIds, SEED, titles, testFiles, toYaml } from '../../scripts/traceability.mjs'
import { exists, read } from './repo'

/**
 * Audit C11 criteria 1 and 2: every §6 test id is in a describe/it/test title, and the traceability matrix
 * (Appendix D) is generated from those titles; a finding without a test fails here and in CI
 * (`node scripts/traceability.mjs --check`).
 */
const AUDIT = 'docs/reviews/compliance_audit.md'
const repoTitles = (): [string, string[]][] => testFiles().map((f: string) => [f, titles(read(f), f)])

describe('traceability (audit Appendix D, C11)', () => {
  it('every finding has a test, every §6 id is in a title, and the committed matrix is what the titles give', () => {
    const m = build(repoTitles(), read(AUDIT), exists, read(POAM))
    expect(m.problems).toEqual([])
    expect(read(OUT), `run \`node scripts/traceability.mjs\` and commit ${OUT}`).toBe(toYaml(m))
  })

  it('an alias finding resolves to a traced one, and every §1.4 M row is covered (phase 11 final review, self-test)', () => {
    const audit = read(AUDIT)
    expect(aliases(audit)).toEqual(expect.arrayContaining([['F-BSI-02', 'F-FIPS-10'], ['F-EL-03', 'F-NIST-08']]))
    expect(mappingRows(audit)).toHaveLength(22)
    const seeded = new Set(aliases(audit).map(([, to]) => to).filter((to) => SEED.findings[to]))
    expect(seeded.size).toBe(2)
    // The bad cases: an alias of a finding nothing traces, an M row nothing covers, a POA&M row that does not cite it.
    const bad = `${audit}\n| F-X-99 | Low | x | See F-NOPE-01 | C5 |\n`
    expect(build([], bad, () => false, read(POAM)).problems).toContain('F-X-99: alias of F-NOPE-01, which is not a traced finding; add F-NOPE-01 to SEED.findings')
    const unmapped = audit.replace('\n| M-22 |', '\n| M-22 |\n| M-23 |')
    expect(build([], unmapped, () => false, read(POAM)).problems).toContain("audit §1.4: M-23 is covered by no WP's tests and no POA&M row; add it to SEED.mrows")
    expect(build([], audit, () => false, read(POAM).replace('M-19', 'M-xx')).problems).toContain('M-19: the POAM-11 row of docs/compliance/poam.md does not cite M-19')
  })

  it('titles are what counts: describe/it/test that run, not comments, strings, skips or todos (self-test)', () => {
    const src = [
      "// T-SELF-01 in a comment is not a test",
      "/* T-SELF-02 neither */",
      "describe('T-SELF-03: x', () => {",
      "  it.each([1])('T-SELF-04 n=%i', () => {})",
      "  it.skipIf(a)('T-SELF-05', () => {})",
      "  test.describe.serial(`T-SELF-06 ${b}`, () => { test('inner', () => {}) })",
      "  it.todo('T-SELF-07 later (C9)')",
      "})",
    ].join('\n')
    expect(titles(src, 'x.test.ts').join(' ').match(/T-SELF-\d+/g)).toEqual(['T-SELF-03', 'T-SELF-04', 'T-SELF-05', 'T-SELF-06'])
    expect(titles('check("T-SELF-08 heap at baseline", ok);\n/* check("T-SELF-09") */', 'kat.c')).toEqual(['T-SELF-08 heap at baseline'])
    expect(expand('T-B-01..03')).toEqual(['T-B-01', 'T-B-02', 'T-B-03'])
  })

  it('a test that never runs, or a title in a string, is no evidence (review C11 bypasses)', () => {
    const none = (src: string, file = 'packages/x/test/x.test.ts') => expect(titles(src, file), src).toEqual([])
    none("it.skip('T-SELF-10', () => { expect(1).toBe(1) })")
    none("test.fixme('T-SELF-11', async () => { expect(1).toBe(1) })", 'packages/desktop/e2e/x.spec.ts')
    none("it.skipIf(true)('T-SELF-12', () => { expect(1).toBe(1) })")
    none("it.runIf(false)('T-SELF-13', () => { expect(1).toBe(1) })")
    none("describe.skip('T-SELF-14', () => { it('inner', () => { expect(1).toBe(1) }) })")
    none("const s = \"it('T-SELF-15', () => {})\"")
    none("describe('T-SELF-16 holds nothing', () => {})")
    // Playwright and guard tests have no assertion requirement at run time, so the title needs an expect.
    none("test('T-SELF-17', async () => {})", 'packages/desktop/e2e/x.spec.ts')
    none("it('T-SELF-18', () => { const x = 1 })", 'tools/guards/x.test.ts')
    none("test.describe('T-SELF-19', () => { test('empty', async () => {}) })", 'packages/desktop/e2e/x.spec.ts')
    expect(titles("test('T-SELF-20', async () => { await expect.poll(() => 1).toBe(1) })", 'packages/desktop/e2e/x.spec.ts')).toEqual(['T-SELF-20'])
  })

  it('--check fails on each bypass applied to the real suite (review C11)', () => {
    const audit = read(AUDIT)
    const swap = (file: string, edit: (text: string) => string) =>
      repoTitles().map(([f, ts]): [string, string[]] => [f, f === file ? titles(edit(read(f)), f) : ts])
    const lock = 'packages/desktop/e2e/lock.spec.ts'
    // An empty body under the real title.
    expect(read(lock)).toContain("test('T-ZERO-05:")
    const emptied = swap(lock, (t) => t.replace(/test\('T-ZERO-05:[\s\S]*?\n\}\)\n/, "test('T-ZERO-05: empty', async () => {})\n"))
    expect(build(emptied, audit, exists).problems).toEqual(expect.arrayContaining([expect.stringContaining('T-ZERO-05')]))
    // Skipped.
    const stat = 'packages/desktop/src/main/static.test.ts'
    const skipped = swap(stat, (t) => t.replace("it('T-GCM-01", "it.skip('T-GCM-01"))
    expect(build(skipped, audit, exists).problems).toEqual(expect.arrayContaining(['F-FIPS-09: T-GCM-01 is in no test title']))
    // Only in a string.
    const quoted = swap(stat, (t) => t.replace("it('T-GCM-01", "const s = \"it('T-GCM-01\"\nit('renamed"))
    expect(build(quoted, audit, exists).problems).toEqual(expect.arrayContaining(['F-FIPS-09: T-GCM-01 is in no test title']))
  })

  it('the check fails when a §6 id loses its last title, or a finding its only test (bypass)', () => {
    const real = repoTitles()
    const audit = read(AUDIT)
    expect(requiredIds(audit)).toContain('T-POST-07')
    const without = (id: string) => real.map(([f, ts]): [string, string[]] => [f, ts.map((t) => t.replaceAll(id, 'renamed'))])
    expect(build(without('T-POST-07'), audit, exists).problems).toEqual(expect.arrayContaining([expect.stringContaining('T-POST-07 is in no describe/it/test title')]))
    // F-FIPS-09's only test is T-GCM-01.
    expect(build(without('T-GCM-01'), audit, exists).problems).toEqual(expect.arrayContaining(['F-FIPS-09: T-GCM-01 is in no test title']))
  })

  it('a pending work package cannot outlive its tests (bypass: leaving C9 pending after it landed)', () => {
    expect([...PENDING_WPS].every((wp) => /^C\d+$/.test(wp))).toBe(true)
    const landed: [string, string[]][] = [
      ...repoTitles(),
      ['packages/desktop/src/main/vault/rotation.test.ts', ['key rotation re-wraps every file']],
      ['packages/desktop/e2e/rotation.spec.ts', ['key rotation from Settings']],
    ]
    const problems = build(landed, read(AUDIT), exists).problems
    for (const wp of PENDING_WPS) expect(problems).toContain(`${wp} has landed (every test it owes is found): take it off PENDING_WPS`)
  })
})
