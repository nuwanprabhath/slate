// "A test that fails without the change and passes with it" (CLAUDE.md, Definition of done),
// checked rather than claimed. The branch's changed unit tests run against the branch BASE's
// packages/*/src in a throwaway worktree, and a NEW test case (an it() the base did not have) must
// fail there, or its file must fail to load (it imports what the change added). An existing test
// whose expectation was edited does not count: bending a test to match a bug also makes it fail on
// the base (red team re-run R3).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const CASE = /\b(?:it|test)(?:\.\w+)*(?:\([^)]*\))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

/** The `it`/`test` cases in a test file (any modifiers), in order: title and body (up to the next case). */
function cases(text) {
  const found = [...text.matchAll(CASE)]
  return found.map((m, i) => ({ title: m[2], body: text.slice(m.index + m[0].length, found[i + 1]?.index ?? text.length).replace(/\s+/g, ' ').trim() }))
}

/** The titles of the `it`/`test` cases in a test file (any modifiers), in order. */
export const caseTitles = (text) => cases(text).map((c) => c.title)

/** Cases in `headText` whose title the base version (`baseText`, null when the file is new) lacks. */
export function newCaseTitles(baseText, headText) {
  const before = new Set(baseText === null ? [] : caseTitles(baseText))
  return caseTitles(headText).filter((t) => !before.has(t))
}

/**
 * Titles added and removed between two versions of a test file. A pure rename (the same body under a
 * new title) is neither; a rename with an edited body is one removed case plus one added (red team
 * G2-3), so retitling a bent test does not make it "new".
 */
export function caseChanges(baseText, headText) {
  const before = baseText === null ? [] : cases(baseText)
  const after = cases(headText)
  const titlesBefore = new Set(before.map((c) => c.title))
  const titlesAfter = new Set(after.map((c) => c.title))
  let added = after.filter((c) => !titlesBefore.has(c.title))
  let removed = before.filter((c) => !titlesAfter.has(c.title))
  for (const c of [...added]) {
    const twin = removed.find((r) => r.body === c.body)
    if (twin) {
      added = added.filter((a) => a !== c)
      removed = removed.filter((r) => r !== twin)
    }
  }
  return { added: added.map((c) => c.title), removed: removed.map((c) => c.title) }
}

/**
 * Red on the base: more new cases failed there than cases were removed (a removed case may have come
 * back under a new title), or a file with new cases failed to load (no results). `report` is vitest's
 * JSON reporter output; `fresh` maps a repo-relative test file to its new titles.
 */
export function redOnBase(report, fresh, removed = 0) {
  let red = 0
  for (const result of report?.testResults ?? []) {
    const file = Object.keys(fresh).find((f) => String(result.name).endsWith(f))
    if (!file || fresh[file].length === 0) continue
    const results = result.assertionResults ?? []
    if (result.status === 'failed' && results.length === 0) return true
    red += results.filter((c) => c.status === 'failed' && fresh[file].includes(c.title)).length
  }
  return red > removed
}

const LAST_RESORT = '(Last resort, only for a pure refactor no test can tell apart: a commit trailer `No-Red-Test-Reason: <why>`. merge-wp prints every trailer and the lead judges it.)'

/** Returns a problem string, or null when shown red on base (or the check does not apply). */
export function testsFailOnBase({ root, base, changed, git }) {
  if (!base) return null
  const src = changed.filter((f) => /^packages\/(core|editor|mcp|importer|sync)\/src\//.test(f) && !f.endsWith('.css'))
  const tests = changed.filter((f) => /^packages\/(core|editor|mcp|importer|sync)\/test\/.*\.test\.tsx?$/.test(f))
  if (src.length === 0 || tests.length === 0) return null
  if (git(['log', '--format=%(trailers:key=No-Red-Test-Reason,valueonly)', `${base}..HEAD`]).trim() !== '') return null

  // A moved test file is compared with its old self, so moving a file adds no "new" case.
  const renamedFrom = {}
  for (const line of git(['diff', '-M', '--name-status', base]).split('\n')) {
    const [status, from, to] = line.split('\t')
    if (status?.startsWith('R') && from && to) renamedFrom[to] = from
  }
  const fresh = {}
  let removed = 0
  for (const t of tests) {
    const was = spawnSync('git', ['show', `${base}:${renamedFrom[t] ?? t}`], { cwd: root, encoding: 'utf8' })
    const change = caseChanges(was.status === 0 ? was.stdout : null, readFileSync(join(root, t), 'utf8'))
    fresh[t] = change.added
    removed += change.removed.length
  }
  // Cases removed on purpose say so (merge-wp prints the trailer for the lead); they are not renames.
  if (git(['log', '--format=%(trailers:key=Removed-Tests-Reason,valueonly)', `${base}..HEAD`]).trim() !== '') removed = 0
  if (Object.values(fresh).every((titles) => titles.length === 0)) {
    return `── no new test case ──\nThe changed tests (${tests.slice(0, 4).join(', ')}) add no new it()/test() case; only existing ones changed. An edited expectation is not proof of a change: it is how a test is bent to match a bug.\nAdd a new test case that states the new behaviour, see it fail on the old code, then make it pass. That is the fix.\n${LAST_RESORT}`
  }

  const dir = mkdtempSync(join(tmpdir(), 'slate-red-on-base-'))
  const tree = join(dir, 'tree')
  try {
    if (spawnSync('git', ['worktree', 'add', '--detach', '--quiet', tree, base], { cwd: root }).status !== 0) return null
    for (const t of tests) {
      mkdirSync(dirname(join(tree, t)), { recursive: true })
      cpSync(join(root, t), join(tree, t))
    }
    // The branch's installed packages, except the workspace links: those must point at the
    // base's own packages, or the "old" code would be the branch's.
    const nm = join(tree, 'node_modules')
    mkdirSync(nm)
    for (const entry of readdirSync(join(root, 'node_modules'))) {
      if (entry !== '@slate') symlinkSync(join(root, 'node_modules', entry), join(nm, entry))
    }
    mkdirSync(join(nm, '@slate'))
    for (const p of readdirSync(join(tree, 'packages'))) {
      const manifest = join(tree, 'packages', p, 'package.json')
      if (!existsSync(manifest)) continue
      const name = JSON.parse(readFileSync(manifest, 'utf8')).name
      if (typeof name === 'string' && name.startsWith('@slate/')) symlinkSync(join(tree, 'packages', p), join(nm, name))
    }
    const out = join(dir, 'report.json')
    spawnSync('node', [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', `--outputFile=${out}`, ...tests], { cwd: tree, encoding: 'utf8' })
    const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
    if (report === null || redOnBase(report, fresh, removed)) return null
    const renamed = removed > 0 ? ` ${removed} case(s) lost their title, so as many red new cases count as renamed ones, not as proof.` : ''
    return `── new tests pass without the change ──\nThe new test cases (${Object.values(fresh).flat().slice(0, 4).join('; ')}) also pass on the base's packages/*/src (${base.slice(0, 8)}), so none of them proves the change.${renamed}\nWrite a test that states the new behaviour, see it fail on the old code, then make it pass. That is the fix.\n${LAST_RESORT}`
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root })
    rmSync(dir, { recursive: true, force: true })
    spawnSync('git', ['worktree', 'prune'], { cwd: root })
  }
}
