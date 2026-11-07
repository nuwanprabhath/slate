#!/usr/bin/env node
// Before and after, from two `measure.mjs` runs on the same machine:
//
//   node .claude/skills/prune-tests/compare.mjs before after
//
// Prints a Markdown table per layer (wall time, tests, files, lines of test code) and writes it to
// `.agent-reports/test-stats/<after>/compare.md`.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [a, b] = process.argv.slice(2)
if (!a || !b) { console.error('usage: compare.mjs <before label> <after label>'); process.exit(2) }
const dir = (l) => join(process.cwd(), '.agent-reports', 'test-stats', l)
const load = (l) => JSON.parse(readFileSync(join(dir(l), 'summary.json'), 'utf8'))
const A = load(a); const B = load(b)

/** The layer a test file belongs to, as `measure.mjs` runs them; null for anything else. */
function layerOf(f) {
  if (f.includes('/node_modules/')) return null
  if (/^packages\/desktop\/e2e\/.*\.spec\.ts$/.test(f)) return 'e2e'
  if (/^tools\/guards\/.*\.test\.ts$/.test(f) || /^tools\/eslint-rules\/.*\.test\.mjs$/.test(f)) return 'guards'
  if (/^packages\/desktop\/src\/main\/.*\.test\.ts$/.test(f)) return 'main'
  if (/^packages\/.*\.test\.ts$/.test(f)) return 'unit'
  return null
}

/** Lines of each layer's test files at a commit, or in the working tree for a run measured on uncommitted changes. */
function testLines(summary) {
  const lines = {}
  const add = (f, text) => { const l = layerOf(f); if (l) lines[l] = (lines[l] ?? 0) + text.split('\n').length }
  if (summary.dirty === true) {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
    for (const f of [...walk('packages'), ...walk('tools')]) if (layerOf(f)) add(f, readFileSync(f, 'utf8'))
    return lines
  }
  const files = spawnSync('git', ['ls-tree', '-r', '--name-only', summary.commit, 'packages', 'tools'], { encoding: 'utf8' }).stdout.split('\n')
  for (const f of files) if (layerOf(f)) add(f, spawnSync('git', ['show', `${summary.commit}:${f}`], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout)
  return lines
}

const pct = (x, y) => (x === 0 ? '' : `${(((y - x) / x) * 100).toFixed(0)}%`)
const row = (name, x, y, fmt = (v) => String(v)) => `| ${name} | ${fmt(x)} | ${fmt(y)} | ${pct(x, y)} |`
const s = (v) => `${v.toFixed(0)} s`
const linesA = testLines(A); const linesB = testLines(B)

const out = [`# Tests: ${a} (${A.commit}) → ${b} (${B.commit})`, '', `Measured on ${B.machine}, one layer at a time.`, '']
let totalA = 0; let totalB = 0
for (const layer of ['unit', 'main', 'guards', 'e2e']) {
  const x = A.layers[layer]; const y = B.layers[layer]
  if (!x || !y) continue
  totalA += x.seconds; totalB += y.seconds
  out.push(`## ${layer}`, '', `| | ${a} | ${b} | change |`, '| --- | ---: | ---: | ---: |',
    row('wall time', x.seconds, y.seconds, s),
    row('tests', x.tests, y.tests), row('files', x.files, y.files),
    row('lines of test code', linesA[layer] ?? 0, linesB[layer] ?? 0),
    row('failed', x.failed, y.failed), '')
}
out.push('## All layers', '', `| | ${a} | ${b} | change |`, '| --- | ---: | ---: | ---: |', row('wall time (excl. the e2e build)', totalA, totalB, s), '')
const md = out.join('\n')
if (existsSync(dir(b))) writeFileSync(join(dir(b), 'compare.md'), md)
console.log(md)
