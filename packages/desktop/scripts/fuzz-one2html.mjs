#!/usr/bin/env node
// Nightly black-box fuzz of the real one2html converter over mutated .one files.
//   node packages/desktop/scripts/fuzz-one2html.mjs --runs 200 --seed 1 [--converter <path>] [--budget 1500]
// Oracle per run: it exits within 60 s, is not killed by a signal, creates nothing outside --output,
// and no href/src in its output leaves the output folder (what would make M4 reachable).
// Exit 0: no violation. Exit 1: a violation, with the seed that reproduces it. Exit 2: bad usage.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../../importer/test/fixtures/one/New Section 1.one')
const TIMEOUT_MS = 60_000

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const num = (name, fallback) => (args.has(`--${name}`) ? Number(args.get(`--${name}`)) : fallback)
const runs = num('runs', 200)
const seed = num('seed', 1)
// Keeps a nightly job inside its slot: stop starting runs once the budget (seconds) is spent.
const budgetMs = num('budget', 1500) * 1000
const converter =
  args.get('--converter') ?? resolve(here, `../resources/bin/one2html-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`)
if (![runs, seed, budgetMs].every(Number.isFinite) || !existsSync(converter)) {
  console.error(`usage: fuzz-one2html.mjs --runs N --seed N [--converter PATH] [--budget SECONDS]\nconverter not found: ${converter} (npm run build:one2html)`)
  process.exit(2)
}

// mulberry32, as in packages/desktop/test/fuzz.ts.
function rng(s) {
  let a = s >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) }
}

function mutate(base, r) {
  let b = Buffer.from(base)
  for (let n = r.int(1, 8); n > 0; n--) {
    const at = r.int(0, Math.max(0, b.length - 1))
    switch (r.int(0, 5)) {
      case 0: b[at] ^= 1 << r.int(0, 7); break
      case 1: b[at] = r.int(0, 255); break
      case 2: b = b.subarray(0, at); break
      case 3: b = Buffer.concat([b.subarray(0, at), b.subarray(at + r.int(1, 64))]); break
      case 4: { const chunk = b.subarray(at, at + r.int(1, 256)); b = Buffer.concat([b.subarray(0, at), chunk, b.subarray(at)]); break }
      default: for (let i = 0; i < 4 && at + i < b.length; i++) b[at + i] = r.int(0, 1) ? 0xff : 0
    }
  }
  return b
}

const list = (dir) => readdirSync(dir).sort().join('\n')

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

/** href/src values in the output that point outside it. */
function escapes(out) {
  const found = []
  for (const file of walk(out)) {
    if (!/\.html?$/i.test(file)) continue
    for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const raw = (m[1] ?? m[2] ?? '').trim()
      if (!raw || raw.startsWith('#') || /^(https?|mailto|data|tel):/i.test(raw)) continue
      let url
      try {
        url = decodeURI(raw.split(/[?#]/)[0])
      } catch {
        url = raw
      }
      const target = url.toLowerCase().startsWith('file:') ? url.replace(/^file:\/*/i, '/') : url
      const resolved = isAbsolute(target) ? target : resolve(dirname(file), target)
      const rel = relative(out, resolved)
      if (rel === '..' || rel.startsWith('..') || isAbsolute(rel)) found.push(`${relative(out, file)}: ${raw}`)
    }
  }
  return found
}

const base = readFileSync(FIXTURE)
const started = Date.now()
let ok = 0
let failed = 0
let done = 0

function violation(run, why) {
  console.error(`VIOLATION run ${run} (seed ${seed}): ${why}\nreproduce: node packages/desktop/scripts/fuzz-one2html.mjs --runs ${run + 1} --seed ${seed} --converter ${converter}`)
  process.exitCode = 1
}

for (let run = 0; run < runs && Date.now() - started < budgetMs; run++) {
  const r = rng(seed + run)
  const scratch = mkdtempSync(join(tmpdir(), 'slate-fuzz-one2html-'))
  try {
    const input = join(scratch, 'in', `case-${run}.one`)
    const out = join(scratch, 'out')
    const cwd = join(scratch, 'cwd')
    for (const d of [dirname(input), out, cwd]) mkdirSync(d)
    writeFileSync(input, mutate(base, r))
    const before = [list(scratch), list(cwd), list(dirname(input))]
    const res = spawnSync(converter, ['--input', input, '--output', out], { cwd, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, stdio: 'ignore' })
    done++
    if (res.error && res.error.code !== 'ENOBUFS') {
      violation(run, res.error.code === 'ETIMEDOUT' ? `no exit within ${TIMEOUT_MS / 1000} s` : `could not run: ${res.error.message}`)
    } else if (res.signal) {
      violation(run, `killed by ${res.signal}`)
    } else {
      const after = [list(scratch), list(cwd), list(dirname(input))]
      if (before.some((b, i) => b !== after[i])) violation(run, `created something outside --output: ${before.map((b, i) => (b === after[i] ? '' : `[${i}] ${after[i]}`)).join(' ')}`)
      const leaks = escapes(out)
      if (leaks.length) violation(run, `output leaves the output folder (M4 is reachable): ${leaks.slice(0, 5).join(' | ')}`)
      if (res.status === 0) ok++
      else failed++
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (process.exitCode === 1) break
}

console.log(`${done} conversions: ${ok} succeeded, ${failed} failed cleanly${done < runs && process.exitCode !== 1 ? ` (stopped by the ${budgetMs / 1000} s budget)` : ''}`)
