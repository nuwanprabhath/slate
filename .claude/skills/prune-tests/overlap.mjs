#!/usr/bin/env node
// What each test file (or each test in one file) covers that nothing else does.
//
//   node .claude/skills/prune-tests/overlap.mjs files [unit main] [--jobs N] [--stats <label>] [--fresh]
//   node .claude/skills/prune-tests/overlap.mjs within <test file> [--stats <label>]
//   node .claude/skills/prune-tests/overlap.mjs lost
//
// `files` runs every Vitest file of the named layers on its own with Node's built-in V8 coverage
// (NODE_V8_COVERAGE: Slate has no coverage package, and a new one needs approval) and compares them
// all at once, unit and main together. `within` runs each test of one file on its own and compares
// them with the rest of the suite (a `files` run must exist). `lost` compares the latest `files` run
// with the first one (`union.before.json`) and lists the source bytes no test covers any more: the
// coverage half of a deletion's proof.
//
// Coverage is byte ranges of the code Vite hands V8, keyed by source path. The transform is the same
// on every run, so ranges from different runs line up; they are not source columns, which is why the
// counts are bytes, not lines. A module's top level is left out: its outer ranges span Vite's inline
// source map too, and every file that imports the module runs it anyway.
// A run reuses its cached result (`cover-*.json`) while the test file is older than the cache;
// `--fresh` redoes every run, and is needed after any change under `src/`.
// Each run uses its package's own config, wrapped (in `tmp/`, never in the repo) to add
// `coverageHook.mjs`: Vitest kills a forked worker before Node writes its coverage, and the
// `threads` pool, which would not, cannot load the native module twice.
//
// A file or test with no unique bytes is a CANDIDATE, not a verdict: coverage says code ran, not
// that anything checked it. SKILL.md says how to decide.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.cwd()
const OUT = join(ROOT, '.agent-reports', 'test-stats', 'overlap')
const argv = process.argv.slice(2)
const flag = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv.splice(i, 2)[1] }
const fresh = argv.includes('--fresh') ? (argv.splice(argv.indexOf('--fresh'), 1), true) : false
const jobs = Number(flag('--jobs', '4'))
const statsLabel = flag('--stats', 'before')
const [mode, ...rest] = argv
mkdirSync(OUT, { recursive: true })

const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'coverageHook.mjs')
const LAYER = {
  // The packages' own projects (packages/*/vitest.config.ts); main-process tests are their own layer.
  unit: { config: 'vitest.config.ts', cmd: process.execPath, env: {}, jobs, owns: (f) => !f.startsWith('packages/desktop/src/main/') },
  // Electron's Node, as `npm run test:main` runs them, with the native module.
  main: { config: 'vitest.main.config.ts', cmd: join(ROOT, 'node_modules', '.bin', 'electron'), env: { ELECTRON_RUN_AS_NODE: '1' }, jobs: Math.min(jobs, 2), owns: (f) => f.startsWith('packages/desktop/src/main/') },
}

/** The package's pinned config with the coverage hook added, written outside the repo's tracked files. */
function wrappedConfig(pkgDir, config) {
  const path = join(OUT, 'tmp', 'configs', `${slug(relative(ROOT, join(pkgDir, config)))}.mjs`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    "import { mergeConfig } from 'vitest/config'",
    `import base from ${JSON.stringify(join(pkgDir, config))}`,
    `export default mergeConfig(base, { root: ${JSON.stringify(pkgDir)}, test: { setupFiles: [${JSON.stringify(HOOK)}] } })`,
  ].join('\n'))
  return path
}

/** Every Vitest file under packages, by layer. */
function testFiles(layer) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'out' || e.name === 'e2e' || e.name.startsWith('.')) return []
    const p = join(d, e.name)
    return e.isDirectory() ? walk(p) : e.name.endsWith('.test.ts') ? [relative(ROOT, p)] : []
  })
  return walk(join(ROOT, 'packages')).filter(LAYER[layer].owns).sort()
}
const layerOf = (file) => (LAYER.main.owns(file) ? 'main' : 'unit')

function slug(s) { return s.replace(/[^a-zA-Z0-9]+/g, '_').slice(-150) }
const PREFIX = `file://${ROOT}/packages/`
/** Product code only: not tests, fixtures, configs or dependencies. */
const isSource = (url) => url.startsWith(PREFIX) && !/\/node_modules\/|\/test\/|\/e2e\/|\.test\.|vitest[^/]*\.config/.test(url)

/**
 * V8's block coverage for one script, as merged covered [start, end) byte ranges. Ranges arrive
 * nested (a function, then its blocks; an inner function as its own entry): painted outermost first,
 * an inner range's count overrides its parent's, so an unrun branch inside a run function is uncovered.
 */
function coveredRanges(functions) {
  const whole = functions.reduce((m, f) => Math.max(m, f.ranges[0].endOffset), 0)
  const ranges = functions.filter((f) => f.ranges[0].endOffset < whole).flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
  const end = ranges.reduce((m, r) => Math.max(m, r.endOffset), 0)
  const paint = new Uint8Array(end)
  for (const r of ranges) paint.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset)
  const out = []
  for (let i = 0; i < end;) {
    if (paint[i] === 0) { i++; continue }
    const s = i
    while (i < end && paint[i] === 1) i++
    out.push([s, i])
  }
  return out
}

/** Union of two sorted, merged range lists. */
function unite(a, b) {
  const all = [...a, ...b].sort((x, y) => x[0] - y[0])
  const out = []
  for (const r of all) {
    const last = out.at(-1)
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r])
  }
  return out
}

/** Bytes two sorted, merged range lists share. */
function shared(a, b) {
  let n = 0; let i = 0; let j = 0
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]); const hi = Math.min(a[i][1], b[j][1])
    if (hi > lo) n += hi - lo
    if (a[i][1] < b[j][1]) i++; else j++
  }
  return n
}

const size = (ranges) => ranges.reduce((n, [s, e]) => n + e - s, 0)
const total = (cover) => Object.values(cover).reduce((n, r) => n + size(r), 0)

/** One Vitest run of one layer with V8 coverage; resolves to { path: ranges }. */
function covered(key, testFile, extra = []) {
  const cache = join(OUT, `cover-${slug(key)}.json`)
  if (!fresh && existsSync(cache) && statSync(cache).mtimeMs > statSync(join(ROOT, testFile)).mtimeMs) return Promise.resolve(JSON.parse(readFileSync(cache, 'utf8')))
  const layer = LAYER[layerOf(testFile)]
  const pkgDir = join(ROOT, testFile.split('/').slice(0, 2).join('/'))
  const dir = join(OUT, 'tmp', slug(key))
  rmSync(dir, { recursive: true, force: true })
  const args = [VITEST, 'run', '--config', wrappedConfig(pkgDir, layer.config), relative(pkgDir, join(ROOT, testFile)), ...extra, '--reporter=dot']
  return new Promise((resolve) => {
    const child = spawn(layer.cmd, args, { cwd: pkgDir, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...layer.env, NODE_V8_COVERAGE: dir } })
    let err = ''
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
    child.on('close', (code) => {
      const cover = {}
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        for (const s of JSON.parse(readFileSync(join(dir, f), 'utf8')).result) {
          if (!isSource(s.url)) continue
          const path = s.url.slice('file://'.length + ROOT.length + 1)
          cover[path] = unite(cover[path] ?? [], coveredRanges(s.functions))
        }
      }
      rmSync(dir, { recursive: true, force: true })
      if (Object.keys(cover).length === 0) console.error(`\noverlap: no coverage for ${key} (exit ${code})\n${err}`)
      else if (code !== 0) console.error(`\noverlap: ${key} exited ${code} (failing tests still give coverage, but less: check it)`)
      writeFileSync(cache, JSON.stringify(cover))
      resolve(cover)
    })
  })
}

async function pool(tasks, n) {
  const results = new Array(tasks.length)
  let next = 0; let done = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
      process.stdout.write(`\roverlap: ${++done}/${tasks.length}`)
    }
  }))
  process.stdout.write('\n')
  return results
}

/** Seconds per test file and per test, from `measure.mjs <statsLabel>`, if it was run. */
function timings() {
  const dir = join(ROOT, '.agent-reports', 'test-stats', statsLabel)
  const file = new Map(); const test = new Map()
  for (const layer of ['unit', 'main']) {
    const p = join(dir, `${layer}.files.json`)
    if (!existsSync(p)) continue
    for (const f of JSON.parse(readFileSync(p, 'utf8'))) {
      file.set(f.file, f.seconds)
      for (const t of f.tests) test.set(`${f.file}::${t.name}`, t.seconds)
    }
  }
  return { file, test }
}

/** Per source file, how many runs cover each byte. */
function counts(runs) {
  const byPath = new Map()
  for (const r of runs) {
    for (const [path, ranges] of Object.entries(r.cover)) {
      const end = ranges.at(-1)?.[1] ?? 0
      let c = byPath.get(path)
      if (!c || c.length < end) { const grown = new Uint16Array(end); if (c) grown.set(c); c = grown; byPath.set(path, c) }
      for (const [s, e] of ranges) for (let i = s; i < e; i++) c[i]++
    }
  }
  return byPath
}

/** For each run: bytes covered, bytes only it covers (and where), and the other run that contains most of it. */
function compare(runs, against) {
  const all = [...runs, ...against]
  const c = counts(all)
  return runs.map((r) => {
    const uniqueBy = {}
    for (const [path, ranges] of Object.entries(r.cover)) {
      const cp = c.get(path)
      let n = 0
      for (const [s, e] of ranges) for (let i = s; i < e; i++) if (cp[i] === 1) n++
      if (n > 0) uniqueBy[path] = n
    }
    const size_ = total(r.cover)
    let best = { key: '', share: 0 }
    if (size_ > 0) {
      for (const o of all) {
        if (o === r) continue
        let n = 0
        for (const [path, ranges] of Object.entries(r.cover)) if (o.cover[path]) n += shared(ranges, o.cover[path])
        if (n / size_ > best.share) best = { key: o.key, share: n / size_ }
      }
    }
    const uniqueFiles = Object.entries(uniqueBy).sort((a, b) => b[1] - a[1]).map(([p]) => p)
    return { key: r.key, covered: size_, unique: Object.values(uniqueBy).reduce((a, b) => a + b, 0), uniqueFiles, best }
  })
}

const table = (rows, seconds) => [
  '| Run | s | bytes covered | unique | where the unique bytes are | most contained by | share |',
  '| --- | ---: | ---: | ---: | --- | --- | ---: |',
  ...rows.map((r) => `| ${r.key} | ${(seconds(r.key) ?? 0).toFixed(1)} | ${r.covered} | ${r.unique} | ${r.uniqueFiles.slice(0, 3).join(', ')}${r.uniqueFiles.length > 3 ? ', …' : ''} | ${r.best.key} | ${(r.best.share * 100).toFixed(0)}% |`),
]

const loadRuns = (keys) => keys.map((k) => ({ key: k, cover: JSON.parse(readFileSync(join(OUT, `cover-${slug(k)}.json`), 'utf8')) }))
function unionOf(runs) {
  const u = {}
  for (const r of runs) for (const [p, ranges] of Object.entries(r.cover)) u[p] = unite(u[p] ?? [], ranges)
  return u
}

if (mode === 'files') {
  const layers = rest.length > 0 ? rest : ['unit', 'main']
  const runs = []
  for (const layer of layers) {
    const files = testFiles(layer)
    console.log(`overlap: ${layer}, ${files.length} files, ${LAYER[layer].jobs} at a time`)
    const covers = await pool(files.map((f) => () => covered(f, f)), LAYER[layer].jobs)
    files.forEach((f, i) => runs.push({ key: f, cover: covers[i] }))
  }
  writeFileSync(join(OUT, 'files.index.json'), JSON.stringify(runs.map((r) => r.key)))
  writeFileSync(join(OUT, 'union.json'), JSON.stringify(unionOf(runs)))
  if (!existsSync(join(OUT, 'union.before.json'))) copyFileSync(join(OUT, 'union.json'), join(OUT, 'union.before.json'))
  const { file } = timings()
  const rows = compare(runs, []).sort((a, b) => a.unique - b.unique || (file.get(b.key) ?? 0) - (file.get(a.key) ?? 0))
  const none = rows.filter((r) => r.unique === 0 && r.covered > 0)
  writeFileSync(join(OUT, 'files.md'), [
    '# Test files by what only they cover', '',
    `${rows.length} files. ${none.length} cover no byte no other file covers; ${rows.filter((r) => r.covered === 0).length} cover no product code at all (they read source, run a script or the C module: judge them by what they assert).`, '',
    ...table(rows, (k) => file.get(k)),
  ].join('\n'))
  console.log(`overlap: wrote ${relative(ROOT, join(OUT, 'files.md'))} (${none.length} files with no unique coverage)`)
} else if (mode === 'within') {
  const target = rest[0]
  if (!target) { console.error('usage: overlap.mjs within <test file>'); process.exit(2) }
  const indexPath = join(OUT, 'files.index.json')
  if (!existsSync(indexPath)) { console.error('overlap: run `overlap.mjs files` first; `within` compares against its runs'); process.exit(2) }
  const others = loadRuns(JSON.parse(readFileSync(indexPath, 'utf8')).filter((k) => k !== target))
  const { test } = timings()
  const names = [...test.keys()].filter((k) => k.startsWith(`${target}::`)).map((k) => k.slice(target.length + 2))
  if (names.length === 0) { console.error(`overlap: no test names for ${target} in measure's ${statsLabel} run`); process.exit(2) }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const covers = await pool(names.map((n) => () => covered(`${target}::${n}`, target, ['-t', `^${esc(n)}$`])), 1)
  const rows = compare(names.map((n, i) => ({ key: `${target}::${n}`, cover: covers[i] })), others).sort((a, b) => a.unique - b.unique)
  const out = join(OUT, `within-${slug(target)}.md`)
  writeFileSync(out, [`# ${target}: what each test covers that nothing else in the suite does`, '', ...table(rows, (k) => test.get(k))].join('\n'))
  console.log(`overlap: wrote ${relative(ROOT, out)}`)
} else if (mode === 'lost') {
  const read = (n) => JSON.parse(readFileSync(join(OUT, n), 'utf8'))
  if (!existsSync(join(OUT, 'union.before.json'))) { console.error('overlap: no union.before.json; run `overlap.mjs files` before the change'); process.exit(2) }
  const before = read('union.before.json'); const now = read('union.json')
  const lost = Object.entries(before).map(([p, r]) => [p, size(r) - shared(r, now[p] ?? [])]).filter(([, n]) => n > 0)
  for (const [p, n] of lost) console.log(`${p}: ${n} bytes no longer covered`)
  console.log(lost.length === 0 ? 'overlap: nothing the suite covered before is uncovered now' : `overlap: ${lost.length} files lost coverage`)
  process.exit(lost.length === 0 ? 0 : 1)
} else {
  console.error('usage: overlap.mjs files [unit main] | within <test file> | lost'); process.exit(2)
}
