#!/usr/bin/env node
// Generates docs/compliance/traceability.yaml (audit Appendix D, C11 criterion 2) from test titles: each finding of
// the audit, the work packages that close it, and for each test it names, the test files whose describe/it/test
// titles carry that id (`check("…")` names in the native C KAT program count as titles). Only titles count, never
// comments, so `grep -r T-POST-07` and this matrix agree on what is tested.
//
//   node scripts/traceability.mjs           write docs/compliance/traceability.yaml
//   node scripts/traceability.mjs --check   fail (exit 1) when a finding has no test, a §6 test id is in no
//                                           title, or the committed file is not what the titles give
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tseslint } from '../tools/lint/index.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const OUT = 'docs/compliance/traceability.yaml'
const AUDIT = 'docs/reviews/compliance_audit.md'
export const POAM = 'docs/compliance/poam.md'

/**
 * Appendix D, the seed. `tests` are §6 ids or the named tests below; a range `T-POST-01..13` stands for every id
 * in it. `poam: true` marks a finding the POA&M carries instead of a test.
 */
export const SEED = {
  findings: {
    'F-FIPS-01': { wp: ['C2', 'C3', 'C4'], tests: ['T-POST-04', 'T-POST-06', 'T-DB-02', 'T-STATIC-02', 'T-KAT-01'] },
    'F-FIPS-02': { wp: ['C4', 'C5'], tests: ['T-POL-07', 'T-KAT-02', 'C5-criterion-2-spy'] },
    'F-FIPS-03': { wp: ['C5'], tests: ['T-KAT-01'], lab: ['L-1'] },
    'F-FIPS-04': { wp: ['C6'], tests: ['T-POST-01', 'T-POST-02', 'T-POST-12'] },
    'F-FIPS-05': { wp: ['C6'], tests: ['T-POST-03', 'T-POST-07', 'T-POST-08', 'T-POST-09', 'T-POST-10'] },
    'F-FIPS-06': { wp: ['C1', 'C7'], tests: ['T-ZERO-01', 'T-ZERO-02', 'T-ZERO-03', 'T-ZERO-04', 'T-ZERO-05', 'T-ZERO-07', 'T-STATIC-01'] },
    'F-FIPS-07': { wp: ['C2', 'C4'], tests: ['T-STATIC-02', 'T-POST-01'] },
    'F-FIPS-08': { wp: ['C2', 'C6'], tests: ['T-POST-01'] },
    'F-FIPS-09': { wp: ['C5', 'C10'], tests: ['T-GCM-01'] },
    'F-FIPS-10': { wp: ['C5'], tests: ['T-FUZZ-12'], lab: ['L-2'] },
    'F-NIST-01': { wp: ['C2', 'C3', 'C4', 'C5'], tests: ['T-POST-04', 'T-DB-02'] },
    'F-NIST-02': { wp: ['C9', 'C10'], tests: ['T-STATIC-03', 'C9-rotation-e2e'] },
    'F-NIST-03': { wp: ['C10'], tests: ['T-POL-02', 'T-POL-03'] },
    'F-NIST-04': { wp: ['C10'], tests: ['T-POL-04'] },
    'F-NIST-05': { wp: ['C10'], tests: ['T-POL-01'] },
    'F-NIST-06': { wp: ['C12'], tests: ['T-UPD-01', 'T-UPD-02', 'T-B-07'] },
    'F-NIST-07': { wp: ['C7'], tests: ['T-ZERO-04', 'T-ZERO-06'] },
    'F-NIST-08': { wp: ['C8'], tests: ['T-B-01', 'T-B-02', 'T-B-03', 'T-B-04'] },
    'F-NIST-09': { wp: ['C8'], tests: ['T-B-05', 'T-B-06'] },
    'F-NIST-10': { wp: ['C10'], tests: [], poam: true },
    'F-NIST-11': { wp: ['C10'], tests: ['C10-redaction-test'] },
    'F-FR-02': { wp: ['C2'], tests: ['T-POST-04'] },
    'F-FR-03': { wp: ['C10'], tests: ['C10-oscal-validation'] },
    'F-BSI-01': { wp: ['C5'], tests: ['T-FUZZ-06', 'T-FUZZ-07'] },
    'F-BSI-04': { wp: ['C5'], tests: ['C5-padme-unit'] },
    'F-CC-01': { wp: ['C5'], tests: ['T-POL-01', 'T-POL-07'] },
    'F-CC-02': { wp: ['C7'], tests: ['T-ZERO-01', 'T-ZERO-04'] },
    'F-CC-03': { wp: ['C6'], tests: ['T-POST-01', 'T-POST-02'] },
    'F-CC-04': { wp: ['C12'], tests: ['T-UPD-01'] },
    'F-EL-01': { wp: ['C8'], tests: ['C8-no-sync-safeStorage-grep'] },
    'F-EL-02': { wp: ['C12'], tests: ['T-B-07', 'T-POST-13'] },
    'F-EL-04': { wp: ['C8'], tests: ['T-POL-08'] },
    'F-GEN-01': { wp: ['C1', 'C5'], tests: ['C1-localKeys-db-binding', 'T-FUZZ-10'] },
    'F-GEN-02': { wp: ['C1'], tests: ['T-FUZZ-13'] },
    'F-GEN-03': { wp: ['C5'], tests: ['T-FUZZ-10'] },
  },
  rules: {
    'S-1..S-11': { wp: ['C6'], tests: ['T-POST-01..13'] },
    'Z-1..Z-12': { wp: ['C1', 'C4', 'C7'], tests: ['T-ZERO-01..08', 'T-STATIC-01'] },
    'B-1..B-7': { wp: ['C8', 'C12'], tests: ['T-B-01..07'] },
    'R-1..R-5': { wp: ['C9'], tests: ['C9-rotation-unit', 'C9-rotation-e2e'] },
  },
  /**
   * §1.4's compliance mapping rows: each is covered by the tests of the WP its "Status → WP" column names, or by
   * the POA&M row (`poam: 'POAM-nn'`) that cites the M id in docs/compliance/poam.md.
   */
  mrows: {
    'M-01': { wp: ['C4', 'C5'], tests: ['T-KAT-02', 'T-POL-07', 'C5-criterion-2-spy'] },
    'M-02': { wp: ['C5'], tests: ['T-KAT-01', 'C5-criterion-2-spy'] },
    'M-03': { wp: ['C5'], tests: ['T-KAT-01', 'T-STATIC-03'] },
    'M-04': { wp: ['C2', 'C4'], tests: ['T-GCM-01', 'T-FUZZ-01', 'T-FUZZ-02'] },
    'M-05': { wp: ['C1', 'C5'], tests: ['C1-localKeys-db-binding', 'T-FUZZ-10'] },
    'M-06': { wp: ['C3'], tests: ['T-DB-01', 'T-DB-02', 'T-DB-03'] },
    'M-07': { wp: ['C5'], tests: ['T-FUZZ-05..09', 'T-KAT-03'] },
    'M-08': { wp: ['C5'], tests: ['T-FUZZ-12'] },
    'M-09': { wp: ['C4'], tests: ['T-FUZZ-12', 'T-STATIC-02'] },
    'M-10': { wp: ['C2'], tests: ['T-POST-04', 'T-STATIC-02'] },
    'M-11': { wp: ['C1', 'C7'], tests: ['T-ZERO-01..07'] },
    'M-12': { wp: ['C6'], tests: ['T-POST-01..13'] },
    'M-13': { wp: ['C8'], tests: ['T-POL-06', 'C8-no-sync-safeStorage-grep'] },
    'M-14': { wp: ['C10'], tests: ['T-POL-02', 'T-POL-03'] },
    'M-15': { wp: ['C10'], tests: ['T-POL-04'] },
    'M-16': { wp: ['C10'], tests: ['T-POL-01'] },
    'M-17': { wp: ['C8'], tests: ['T-B-01..04', 'T-POL-08'] },
    'M-18': { wp: ['C12'], tests: ['T-UPD-01', 'T-UPD-02', 'T-B-07'] },
    'M-19': { wp: ['C10'], tests: [], poam: 'POAM-11' },
    'M-20': { wp: ['C10'], tests: ['C10-oscal-validation'] },
    'M-21': { wp: ['C4'], tests: ['T-FUZZ-10'] },
    'M-22': { wp: ['C10'], tests: ['C10-redaction-test'] },
  },
}

/**
 * The tests Appendix D names without a §6 id: the title (and, where it matters, the file) that is each one.
 * `file` alone (no `title`) is evidence that is not a vitest title, such as a CI-run validator script.
 */
export const NAMED = {
  'C5-criterion-2-spy': { title: /C5 criterion 2/, file: /vault\/fipsProfile\.test\.ts$/ },
  'C9-rotation-unit': { title: /\brotat/i, file: /src\/main\/vault\/.*\.test\.ts$/, wp: 'C9' },
  'C9-rotation-e2e': { title: /\brotat/i, file: /e2e\/.*\.spec\.ts$/, wp: 'C9' },
  'C10-redaction-test': { title: /./, file: /test\/spec\/redact\.test\.ts$/ },
  'C10-oscal-validation': { exists: 'scripts/validate-oscal.mjs' },
  'C8-no-sync-safeStorage-grep': { title: /safeStorage/, file: /tools\/guards\/boundary\.test\.ts$/ },
  'C1-localKeys-db-binding': { title: /F-GEN-01/, file: /vault\/localKeys\.test\.ts$/ },
  'C5-padme-unit': { title: /padm[eé]/i, file: /\.test\.ts$/ },
}

/**
 * Work packages not merged yet: a named test of one of these may still be missing, and the matrix says `pending`.
 * Once every test of a pending package is found, the check fails until the package is taken off this list, so
 * the exception cannot outlive the package it waits for.
 */
export const PENDING_WPS = new Set([])

export const ID = /\bT-[A-Z]+-\d+\b/g

/** `T-POST-01..13` → T-POST-01 … T-POST-13; anything else is itself. */
export function expand(test) {
  const m = /^(T-[A-Z]+-)(\d+)\.\.(\d+)$/.exec(test)
  if (!m) return [test]
  const [, prefix, from, to] = m
  const out = []
  for (let n = Number(from); n <= Number(to); n++) out.push(`${prefix}${String(n).padStart(from.length, '0')}`)
  return out
}

/** Every T- id the audit's §6 (the test-suite specification) names. */
export function requiredIds(audit) {
  const start = audit.indexOf('\n## 6.')
  const end = audit.indexOf('\n## 7.', start)
  if (start < 0 || end < 0) throw new Error(`${AUDIT}: no §6`)
  return [...new Set(audit.slice(start, end).match(ID) ?? [])].sort()
}

/** The §1.4 mapping rows (`| M-01 | … |`). */
export function mappingRows(audit) {
  const start = audit.indexOf('\n### 1.4')
  const end = audit.indexOf('\n#', start + 1)
  if (start < 0 || end < 0) throw new Error(`${AUDIT}: no §1.4`)
  return [...audit.slice(start, end).matchAll(/^\| (M-\d+) \|/gm)].map((m) => m[1])
}

/** Findings the audit lists only as another's alias (`| F-BSI-02 | … | See F-FIPS-10 |`, `(= F-NIST-08)`): [alias, target]. */
export function aliases(audit) {
  const out = []
  for (const m of audit.matchAll(/^\| (F-[A-Z]+-\d+) \|(.*)$/gm)) {
    const to = /(?:\bSee |\(= ?)(F-[A-Z]+-\d+)/.exec(m[2])
    if (to) out.push([m[1], to[1]])
  }
  return out
}

/** The POA&M row `id` (`| POAM-11 | … |`) in poam.md, or null. */
const poamRow = (poam, id) => poam.split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? null

/** Runner modifiers under which a test does not run: a todo, a skip, a Playwright fixme. */
const NOT_RUN = new Set(['skip', 'todo', 'fixme'])
const RUNNERS = new Set(['it', 'test', 'describe'])
/** Playwright and the guard tests have no `expect.requireAssertions` at run time: their titles need an `expect` in the body. */
const NEEDS_EXPECT = /(^|\/)(e2e|e2e-packaged)\/|^tools\/guards\/|\.linux\.ts$/

/** Calls `fn` on every node under `node` (not following `parent`). */
function walkAst(node, fn) {
  if (!node || typeof node.type !== 'string') return
  fn(node)
  for (const [k, v] of Object.entries(node)) {
    if (k === 'parent') continue
    if (Array.isArray(v)) for (const c of v) walkAst(c, fn)
    else if (v && typeof v === 'object' && typeof v.type === 'string') walkAst(v, fn)
  }
}

/** The runner a call chain starts from and the member names on the way (`it.skip.each([…])` → it, [skip, each]). */
function chainOf(callee) {
  const members = []
  const calls = []
  let n = callee
  while (n && (n.type === 'MemberExpression' || n.type === 'CallExpression')) {
    if (n.type === 'MemberExpression') {
      if (n.property.type === 'Identifier') members.unshift(n.property.name)
      n = n.object
    } else {
      calls.unshift(n)
      n = n.callee
    }
  }
  return { root: n?.type === 'Identifier' ? n.name : null, members, calls }
}

/** False when the chain cannot run: `.skip`, `.todo`, `.fixme`, `skipIf(true)`, `runIf(false)`. */
function runs(chain) {
  if (chain.members.some((m) => NOT_RUN.has(m))) return false
  for (const c of chain.calls) {
    const name = c.callee.type === 'MemberExpression' && c.callee.property.type === 'Identifier' ? c.callee.property.name : null
    const arg = c.arguments[0]
    if (name === 'skipIf' && arg?.type === 'Literal' && arg.value === true) return false
    if (name === 'runIf' && arg?.type === 'Literal' && arg.value === false) return false
  }
  return true
}

const titleText = (arg) => {
  if (arg?.type === 'Literal' && typeof arg.value === 'string') return arg.value
  if (arg?.type === 'TemplateLiteral') return arg.quasis.map((q) => q.value.cooked ?? q.value.raw).join('${…}')
  return null
}

const hasExpect = (fn) => {
  let found = false
  walkAst(fn, (n) => {
    if (!found && n.type === 'CallExpression' && chainOf(n.callee).root === 'expect') found = true
  })
  return found
}

/**
 * The titles in one file that are evidence (parsed, so comments and strings never count): a describe/it/test
 * (with `.each`, `.concurrent`, `.serial`, `skipIf`/`runIf` on a runtime condition…) that runs, not `.skip`,
 * `.todo`, `.fixme`, `skipIf(true)` or `runIf(false)`, nor anything inside one. A test in a Playwright spec or a
 * guard test needs an `expect` in its body; a vitest test is held to one at run time (`requireAssertions`).
 * A describe counts when a test inside it counts. C: the `check("…")` names of the KAT program.
 */
export function titles(text, file) {
  if (file.endsWith('.c')) {
    const src = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    return [...src.matchAll(/\bcheck\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  }
  const { ast } = tseslint.parser.parseForESLint(text, { ecmaFeatures: { jsx: file.endsWith('.tsx') }, range: false, loc: false, comment: false })
  const needsExpect = NEEDS_EXPECT.test(file)
  const out = []
  /** Visits `node`; returns whether a counted test is inside it. */
  const visit = (node) => {
    let counted = false
    const scan = (n) => {
      if (!n || typeof n.type !== 'string') return
      if (n.type === 'CallExpression') {
        const chain = chainOf(n.callee)
        if (RUNNERS.has(chain.root ?? '') && titleText(n.arguments[0]) !== null && n.arguments.some((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression')) {
          if (!runs(chain)) return
          const title = titleText(n.arguments[0])
          const body = n.arguments.find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression')
          const isDescribe = chain.root === 'describe' || chain.members.includes('describe')
          if (isDescribe) {
            const at = out.length
            if (visit(body.body)) {
              out.splice(at, 0, title)
              counted = true
            }
          } else if (!needsExpect || hasExpect(body)) {
            out.push(title)
            counted = true
          }
          return
        }
      }
      for (const [k, v] of Object.entries(n)) {
        if (k === 'parent') continue
        if (Array.isArray(v)) for (const c of v) scan(c)
        else if (v && typeof v === 'object' && typeof v.type === 'string') scan(v)
      }
    }
    scan(node)
    return counted
  }
  visit(ast)
  return out
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'release', 'coverage', 'test-results', 'deps', '.claude', 'prebuilds', 'fips'])
const TEST_FILE = /(\.test\.(ts|tsx|mjs)|\.spec\.ts|\/e2e\/[^/]+\.linux\.ts|\/test\/kat\.c)$/

export function testFiles(root = ROOT) {
  const out = []
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(join(dir, d.name))
      } else {
        const rel = relative(root, join(dir, d.name)).split('\\').join('/')
        if (TEST_FILE.test(rel)) out.push(rel)
      }
    }
  }
  for (const top of ['packages', 'tools', 'scripts']) walk(join(root, top))
  return out.sort()
}

/** id → sorted files whose titles carry it, for every id and named test. */
export function evidence(filesTitles, exists = () => false) {
  const byId = new Map()
  const add = (id, file) => {
    if (!byId.has(id)) byId.set(id, new Set())
    byId.get(id).add(file)
  }
  for (const [file, ts] of filesTitles) {
    for (const t of ts) {
      for (const id of t.match(ID) ?? []) add(id, file)
      for (const [name, rule] of Object.entries(NAMED)) if (rule.title && rule.title.test(t) && rule.file.test(file)) add(name, file)
    }
  }
  for (const [name, rule] of Object.entries(NAMED)) if (rule.exists && exists(rule.exists)) add(name, rule.exists)
  return new Map([...byId].map(([k, v]) => [k, [...v].sort()]))
}

/** The matrix and everything wrong with it. */
export function build(filesTitles, audit, exists = () => false, poam = '') {
  const ev = evidence(filesTitles, exists)
  const problems = []
  const section = (entries) =>
    Object.entries(entries).map(([id, f]) => {
      const tests = f.tests.flatMap(expand).map((t) => [t, ev.get(t) ?? (PENDING_WPS.has(NAMED[t]?.wp) ? [`pending ${NAMED[t].wp}`] : [])])
      for (const [t, files] of tests) if (files.length === 0) problems.push(`${id}: ${t} is in no test title`)
      if (tests.length === 0 && !f.poam) problems.push(`${id}: no test, and not a POA&M entry`)
      return { id, ...f, tests }
    })
  for (const wp of PENDING_WPS) {
    const names = Object.entries(NAMED).filter(([, r]) => r.wp === wp).map(([n]) => n)
    if (names.length > 0 && names.every((n) => ev.has(n))) problems.push(`${wp} has landed (every test it owes is found): take it off PENDING_WPS`)
  }
  const findings = section(SEED.findings)
  const rules = section(SEED.rules)
  const alias = aliases(audit)
  for (const [a, to] of alias) {
    if (SEED.findings[a]) problems.push(`${a}: the audit lists it as an alias of ${to}; trace ${to} and take ${a} out of SEED.findings`)
    else if (!SEED.findings[to]) problems.push(`${a}: alias of ${to}, which is not a traced finding; add ${to} to SEED.findings`)
  }
  const mIds = mappingRows(audit)
  for (const id of mIds) if (!SEED.mrows[id]) problems.push(`audit §1.4: ${id} is covered by no WP's tests and no POA&M row; add it to SEED.mrows`)
  for (const id of Object.keys(SEED.mrows)) if (!mIds.includes(id)) problems.push(`SEED.mrows: ${id} is not a §1.4 row of the audit`)
  for (const [id, r] of Object.entries(SEED.mrows)) {
    if (typeof r.poam !== 'string') continue
    const row = poamRow(poam, r.poam)
    if (!row) problems.push(`${id}: ${r.poam} is not a row of docs/compliance/poam.md`)
    else if (!new RegExp(`\\b${id}\\b`).test(row)) problems.push(`${id}: the ${r.poam} row of docs/compliance/poam.md does not cite ${id}`)
  }
  const mrows = section(SEED.mrows)
  const required = requiredIds(audit).map((t) => [t, ev.get(t) ?? []])
  for (const [t, files] of required) if (files.length === 0) problems.push(`audit §6: ${t} is in no describe/it/test title`)
  return { findings, rules, aliases: alias, mrows, required, problems: [...new Set(problems)] }
}

const list = (xs) => `[${xs.join(', ')}]`

export function toYaml(m) {
  const lines = [
    `# ${OUT}: generated by scripts/traceability.mjs from test titles (audit Appendix D, C11). Do not edit;`,
    '# run `node scripts/traceability.mjs` after changing a test title. CI runs it with --check.',
  ]
  const entry = (e) => {
    lines.push(`  ${e.id}:`)
    lines.push(`    wp: ${list(e.wp)}`)
    if (e.lab) lines.push(`    lab: ${list(e.lab)}`)
    if (e.poam) lines.push(`    poam: ${e.poam}`)
    if (e.tests.length === 0) lines.push('    tests: {}')
    else {
      lines.push('    tests:')
      for (const [t, files] of e.tests) lines.push(`      ${t}: ${list(files)}`)
    }
  }
  lines.push('findings:')
  m.findings.forEach(entry)
  lines.push('aliases:')
  for (const [a, to] of m.aliases) lines.push(`  ${a}: ${to}`)
  lines.push('rules:')
  m.rules.forEach((r) => entry({ ...r, id: `"${r.id}"` }))
  lines.push('mapping:')
  m.mrows.forEach(entry)
  lines.push('tests:')
  for (const [t, files] of m.required) lines.push(`  ${t}: ${list(files)}`)
  return `${lines.join('\n')}\n`
}

function main() {
  const check = process.argv.includes('--check')
  const filesTitles = testFiles().map((f) => [f, titles(readFileSync(join(ROOT, f), 'utf8'), f)])
  const audit = readFileSync(join(ROOT, AUDIT), 'utf8')
  const exists = (p) => {
    try {
      readFileSync(join(ROOT, p))
      return true
    } catch {
      return false
    }
  }
  const m = build(filesTitles, audit, exists, readFileSync(join(ROOT, POAM), 'utf8'))
  const yaml = toYaml(m)
  const problems = [...m.problems]
  if (check) {
    let committed = ''
    try {
      committed = readFileSync(join(ROOT, OUT), 'utf8')
    } catch {
      // Missing: reported below.
    }
    if (committed !== yaml) problems.push(`${OUT} is not what the test titles give: run \`node scripts/traceability.mjs\` and commit it`)
  } else writeFileSync(join(ROOT, OUT), yaml)
  for (const p of problems) process.stderr.write(`traceability: ${p}\n`)
  if (problems.length > 0) process.exit(1)
  process.stdout.write(`traceability: ${m.findings.length} findings, ${m.aliases.length} aliases, ${m.mrows.length} §1.4 rows, ${m.rules.length} rule groups, ${m.required.length} §6 test ids, all traced\n`)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
