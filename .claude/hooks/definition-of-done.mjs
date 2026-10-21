#!/usr/bin/env node
// Stop / SubagentStop: "done" means the definition of done in CLAUDE.md, checked rather than
// claimed. The whole branch since it left SLATE_BASE_REF (default main) is judged, not only
// uncommitted edits: an agent that commits half a feature and stops must still be caught.
// Exit 2 = the reason is shown to Claude and it continues. After MAX_BLOCKS blocked stops in a row
// it may stop, but `<git dir>/slate-not-done` keeps the failures for whoever reviews the branch.
// Adapted from Apiary's hook; each check there came from an agent that claimed done when it wasn't.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { testsFailOnBase } from './testsFailOnBase.mjs'

let input = {}
try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { /* no input: use the defaults */ }
const MAX_BLOCKS = 5

const root = typeof input.cwd === 'string' ? input.cwd : process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const pkg = join(root, 'package.json')
if (!existsSync(pkg) || JSON.parse(readFileSync(pkg, 'utf8')).name !== 'slate') process.exit(0)

const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout ?? ''
const gitDir = git(['rev-parse', '--absolute-git-dir']).trim()
const blocksFile = gitDir ? join(gitDir, 'slate-stop-blocks') : ''
const notDoneFile = gitDir ? join(gitDir, 'slate-not-done') : ''
const passed = () => {
  for (const f of [blocksFile, notDoneFile]) if (f && existsSync(f)) rmSync(f)
  process.exit(0)
}

const baseRef = process.env.SLATE_BASE_REF || 'main'
const base = git(['merge-base', 'HEAD', baseRef]).trim()
const changed = [...new Set([
  ...(base ? git(['diff', '--name-only', base]).split('\n') : []),
  ...git(['diff', '--name-only', 'HEAD']).split('\n'),
  ...git(['ls-files', '--others', '--exclude-standard']).split('\n'),
])].filter((f) => f !== '' && existsSync(join(root, f)))
const code = changed.filter((f) => /^packages\//.test(f) || /\.(ts|tsx|mjs|css)$/.test(f))
if (code.length === 0) passed()

const problems = []
const run = (label, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) problems.push(`── ${label} ──\n${`${r.stdout}${r.stderr}`.split('\n').slice(-60).join('\n')}`)
}
run('typecheck', 'npx', ['--no', '--', 'tsc', '-p', 'tsconfig.json'])

// Every unit test, not only the changed ones: core and editor are fast, and a change in core can
// break the editor's tests.
if (changed.some((f) => /^packages\/(core|editor)\//.test(f))) run('unit tests (npm test)', 'npm', ['test', '--silent'])
if (changed.some((f) => /^packages\/desktop\/src\/main\//.test(f))) run('main-process tests (npm run test:main)', 'npm', ['run', 'test:main', '--silent'])

const isTest = (f) => /\.(test|spec)\.tsx?$/.test(f)
const trailer = (key) => (base ? git(['log', `--format=%(trailers:key=${key},valueonly)`, `${base}..HEAD`]).trim() : '')

// A behaviour change comes with a test, unless a commit says why (a pure move, a comment, styles).
{
  const src = changed.filter((f) => /^packages\/[^/]+\/src\//.test(f) && !isTest(f) && !f.endsWith('.css'))
  const tests = changed.filter(isTest)
  if (src.length > 0 && tests.length === 0 && trailer('No-Test-Reason') === '') {
    problems.push(`── no test ──\nThis branch changes ${String(src.length)} source file(s) (${src.slice(0, 4).join(', ')}) and no test.\nAdd a test in the cheapest layer that proves the change (unit in packages/*/test, e2e in packages/desktop/e2e). If it truly needs none, say why in a commit trailer: \`No-Test-Reason: <why>\`.`)
  }
}

// Done work is committed work.
{
  const dirty = git(['status', '--porcelain']).split('\n').filter((l) => l.trim() !== '').map((l) => l.slice(3))
  if (dirty.length > 0) problems.push(`── uncommitted ──\n${String(dirty.length)} changed file(s) are not committed (${dirty.slice(0, 5).join(', ')}).\nCommit them (Conventional Commit, no AI attribution) once the checks above pass.`)
}

// Tests are not deleted to get green: fewer test cases per touched file fails without a reason.
if (base) {
  const CASE = /\b(?:it|test)(?:\.(?:only|skip|todo|each\([^)]*\)))?\s*\(/g
  const count = (text) => (text.match(CASE) ?? []).length
  const touched = git(['diff', '--name-only', base]).split('\n').filter(isTest)
  const lost = []
  for (const f of touched) {
    const was = count(spawnSync('git', ['show', `${base}:${f}`], { cwd: root, encoding: 'utf8' }).stdout ?? '')
    const now = existsSync(join(root, f)) ? count(readFileSync(join(root, f), 'utf8')) : 0
    if (now < was) lost.push(`${f}: ${String(was)} → ${String(now)}`)
  }
  if (lost.length > 0 && trailer('Removed-Tests-Reason') === '') {
    problems.push(`── tests removed ──\n  ${lost.join('\n  ')}\nKeep the behaviour they checked. If it was removed on purpose, say so in a commit trailer: \`Removed-Tests-Reason: <why>\`.`)
  }
  // `.only` silently skips every other test in the file.
  const only = changed.filter((f) => isTest(f) && /\b(?:it|test|describe)\.only\s*\(/.test(readFileSync(join(root, f), 'utf8')))
  if (only.length > 0) problems.push(`── .only left in ──\n${only.join(', ')}: remove .only so the whole file runs.`)
}

// The tests above pass with the change; at least one must fail without it. Slowest, so last.
if (problems.length === 0) {
  const red = testsFailOnBase({ root, base, changed, git })
  if (red !== null) problems.push(red)
}

if (problems.length === 0) passed()
const blocks = (blocksFile && existsSync(blocksFile) ? Number(readFileSync(blocksFile, 'utf8')) || 0 : 0) + 1
if (blocksFile) writeFileSync(blocksFile, String(blocks))
if (blocks > MAX_BLOCKS) {
  if (notDoneFile) writeFileSync(notDoneFile, `NOT DONE — stopped after ${String(MAX_BLOCKS)} blocked attempts.\n\n${problems.join('\n')}\n`)
  process.stderr.write(`Stopping with the definition of done still failing; recorded in ${notDoneFile}. Say so in your report: these checks FAIL.\n`)
  process.exit(0)
}
process.stderr.write(`Not done yet (blocked ${String(blocks)}/${String(MAX_BLOCKS)}) — the definition of done (CLAUDE.md) fails on this branch:\n\n${problems.join('\n')}\nFix these, then finish. Do not report a check as passing that this hook shows failing.\n`)
process.exit(2)
