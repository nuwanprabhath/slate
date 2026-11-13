import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { baseCommit, exists, git, isTestFile, read, ROOT, walk } from './repo'

/**
 * The fuzz harnesses stay honest the way ratchet.test.ts keeps the allowlists honest
 * (docs/architecture/golden-paths.md, "Fuzzing"):
 *  1. every corpus folder is replayed by a `replayCorpus(` call and is not empty, and every call names
 *     a folder that exists;
 *  2. a corpus file is at most 64 KiB, a folder at most 1 MiB, and a file is named by the first 16 hex
 *     of the SHA-256 of its own bytes;
 *  3. the regression corpus only grows: no corpus file on the base is missing;
 *  4. every `fc.assert(` takes its runs and seed from the kit (`fcParams`, `fcRuns(`) or a literal `seed:`;
 *  5. no shipped source imports fast-check or a kit file.
 * The native corpus (packages/native/fuzz/corpus) is replayed by the C standalone driver, not by
 * replayCorpus, so rule 1 leaves it out; rules 2 and 3 cover it.
 */
const GUIDE = 'see docs/architecture/golden-paths.md, "Fuzzing"'
const FILE_CAP = 64 * 1024
const FOLDER_CAP = 1024 * 1024
const KIT = /(^|\/)test\/(fuzz|fuzzBytes|fuzzCorpus|fuzzDeadline|fuzzHtml)(\.ts)?$/

const packages = (): string[] => readdirSync(join(ROOT, 'packages')).filter((p) => exists(`packages/${p}/package.json`))
const subdirs = (rel: string): string[] =>
  exists(rel) ? readdirSync(join(ROOT, rel), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `${rel}/${d.name}`) : []

/** Replayed corpus folders, `packages/<pkg>/test/corpus/<target>`. */
const replayedFolders = (): string[] => packages().flatMap((p) => subdirs(`packages/${p}/test/corpus`))
const allFolders = (): string[] => [...replayedFolders(), ...subdirs('packages/native/fuzz/corpus')]
const filesIn = (rel: string): string[] => readdirSync(join(ROOT, rel)).filter((n) => !n.startsWith('.') && statSync(join(ROOT, rel, n)).isFile())

/** The folders named by literal `replayCorpus('<pkg>', '<target>'` calls in `text`. */
export function replayTargets(text: string): string[] {
  return [...text.matchAll(/\breplayCorpus\(\s*['"`]([\w.-]+)['"`]\s*,\s*['"`]([\w.-]+)['"`]/g)].map((m) => `packages/${m[1] ?? ''}/test/corpus/${m[2] ?? ''}`)
}

/** Rule 1 over a folder list and the replayed targets: the problems, as messages. */
export function replayProblems(folders: Record<string, number>, targets: readonly string[]): string[] {
  const out: string[] = []
  for (const [dir, count] of Object.entries(folders)) {
    if (!targets.includes(dir)) out.push(`${dir} is replayed by no replayCorpus() call: add one to the target's *Fuzz.test.ts (${GUIDE})`)
    if (count === 0) out.push(`${dir} is empty: commit at least one seed input, or remove the folder and its replayCorpus() call (${GUIDE})`)
  }
  for (const t of targets) if (!(t in folders)) out.push(`replayCorpus() names ${t}, which does not exist: commit its seed inputs there (${GUIDE})`)
  return out
}

/** Rule 2 for one file: its name problem and size problem, if any. */
export function fileProblems(rel: string, bytes: Uint8Array): string[] {
  const out: string[] = []
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  const want = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  if (name.split('.')[0] !== want) out.push(`${rel} must be named ${want} (the first 16 hex of the SHA-256 of its bytes) plus its extension (${GUIDE})`)
  if (bytes.length > FILE_CAP) out.push(`${rel} is ${String(bytes.length)} bytes; a corpus file is at most 64 KiB: minimise it (minimizeBytes, -minimize_crash=1) (${GUIDE})`)
  return out
}

/** Rule 3: base corpus paths missing now. */
export function lostFiles(before: readonly string[], present: (rel: string) => boolean): string[] {
  return before.filter((rel) => !present(rel)).map((rel) => `${rel} was deleted; the regression corpus only grows: restore it (${GUIDE})`)
}

/** Rule 4: the `fc.assert(` calls in `text` that pass neither the kit's parameters nor a literal seed, by line. */
export function unseededAsserts(text: string): number[] {
  const bad: number[] = []
  const fromKit = /\bfcParams\b|\bfcRuns\(|\bseed\s*:/
  for (let i = text.indexOf('fc.assert('); i !== -1; i = text.indexOf('fc.assert(', i + 1)) {
    let depth = 0
    let j = i + 'fc.assert'.length
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++
      else if (text[j] === ')' && --depth === 0) break
    }
    const call = text.slice(i, j + 1)
    if (fromKit.test(call)) continue
    // `fc.assert(prop, params)` where `const params = { ...fcParams, … }` or `fcRuns(…)` in the same file.
    const last = /,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)$/.exec(call)?.[1]
    const decl = last === undefined ? null : new RegExp(`\\bconst ${last}\\s*(?::[^=]+)?=([^\\n]*)`).exec(text)
    if (decl?.[1] !== undefined && fromKit.test(decl[1])) continue
    bad.push(text.slice(0, i).split('\n').length)
  }
  return bad
}

/** Rule 5: does this module text import fast-check or a kit file? */
export function importsFuzzKit(text: string): boolean {
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)['"`]([^'"`]+)['"`]/g)].some((m) => m[1] === 'fast-check' || KIT.test(m[1] ?? ''))
}

const base = baseCommit()

describe('fuzz corpus and kit guard', () => {
  it('every corpus folder is replayed and not empty, and every replayCorpus() names a folder (rule 1)', () => {
    const folders = Object.fromEntries(replayedFolders().map((d) => [d, filesIn(d).length]))
    const targets = packages().flatMap((p) => (exists(`packages/${p}/test`) ? walk(`packages/${p}/test`, ['.ts', '.tsx']) : []).filter(isTestFile).flatMap((f) => replayTargets(read(f))))
    expect(replayProblems(folders, targets)).toEqual([])
  })

  it('corpus files are small and named by their own hash, folders at most 1 MiB (rule 2)', () => {
    const problems: string[] = []
    for (const dir of allFolders()) {
      let total = 0
      for (const name of filesIn(dir)) {
        const bytes = new Uint8Array(readFileSync(join(ROOT, dir, name)))
        total += bytes.length
        problems.push(...fileProblems(`${dir}/${name}`, bytes))
      }
      if (total > FOLDER_CAP) problems.push(`${dir} holds ${String(total)} bytes; a corpus folder is at most 1 MiB: minimise its inputs (${GUIDE})`)
    }
    expect(problems).toEqual([])
  })

  it('no corpus file on the base is missing (rule 3)', () => {
    // Outside a checkout with history (a source tarball) there is no base, so nothing can be lost.
    const listing = base === null ? '' : git(['ls-tree', '-r', '--name-only', base, '--', 'packages'])
    const before = listing
      .split('\n')
      .filter((rel) => /^packages\/[^/]+\/test\/corpus\/[^/]+\/[^/]+$/.test(rel) || rel.startsWith('packages/native/fuzz/corpus/'))
    expect(lostFiles(before, exists)).toEqual([])
  })

  it('every fc.assert takes its runs and seed from the kit (rule 4)', () => {
    const bad = walk('packages', ['.ts', '.tsx'])
      .filter(isTestFile)
      .flatMap((f) => unseededAsserts(read(f)).map((line) => `${f}:${String(line)}: fc.assert without fcParams, fcRuns() or a literal seed: pass the kit's parameters from packages/desktop/test/fuzz.ts so CI is deterministic and the nightly soak can widen it (${GUIDE})`))
    expect(bad).toEqual([])
  })

  it('no shipped source imports fast-check or a fuzz kit file (rule 5)', () => {
    const bad = packages()
      .flatMap((p) => (exists(`packages/${p}/src`) ? walk(`packages/${p}/src`, ['.ts', '.tsx', '.mjs']) : []))
      .filter((f) => !isTestFile(f) && importsFuzzKit(read(f)))
      .map((f) => `${f} imports fast-check or a fuzz kit file; only test files may: move the code into a test (${GUIDE})`)
    expect(bad).toEqual([])
  })

  it('each rule catches what it is for (self-test)', () => {
    const t = 'packages/sync/test/corpus/loro-update'
    expect(replayTargets(`replayCorpus('sync', 'loro-update', (b) => {})`)).toEqual([t])
    expect(replayProblems({ [t]: 1 }, [t])).toEqual([])
    expect(replayProblems({ [t]: 0 }, [t])).toHaveLength(1)
    expect(replayProblems({ [t]: 1 }, [])).toHaveLength(1)
    expect(replayProblems({}, [t])).toHaveLength(1)

    const bytes = new TextEncoder().encode('<p>x</p>')
    const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    expect(fileProblems(`${t}/${name}.html`, bytes)).toEqual([])
    expect(fileProblems(`${t}/0000000000000000.html`, bytes)).toHaveLength(1)
    const big = new Uint8Array(FILE_CAP + 1)
    expect(fileProblems(`${t}/${createHash('sha256').update(big).digest('hex').slice(0, 16)}.bin`, big)).toHaveLength(1)

    expect(lostFiles([`${t}/a.bin`, `${t}/b.bin`], (rel) => rel.endsWith('a.bin'))).toHaveLength(1)

    expect(unseededAsserts('fc.assert(fc.property(fc.string(), () => {}))')).toEqual([1])
    expect(unseededAsserts('fc.assert(fc.property(fc.string(), (s) => f(s)), fcParams)')).toEqual([])
    expect(unseededAsserts('fc.assert(p, fcRuns(10))')).toEqual([])
    expect(unseededAsserts('fc.assert(p, { numRuns: 5, seed: 1 })')).toEqual([])
    expect(unseededAsserts('const params = { ...fcParams, numRuns: 9 }\nfc.assert(p, params)')).toEqual([])
    expect(unseededAsserts('const params = { numRuns: 9 }\nfc.assert(p, params)')).toEqual([2])

    expect(importsFuzzKit(`import fc from 'fast-check'`)).toBe(true)
    expect(importsFuzzKit(`import { fcParams } from '../../test/fuzz'`)).toBe(true)
    expect(importsFuzzKit(`import { x } from './fuzzy'`)).toBe(false)
  })
})
