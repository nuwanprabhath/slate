import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseCommit, git, read, readAt, ROOT, walk } from './repo'

/**
 * The test suites cannot be quietly shrunk (red team 10a/10b): every project collects what its
 * pinned include says, excludes nothing, fails a test with no assertion, and the scripts that run
 * them stay what CI and the Stop hook expect. Skips and test files are ratcheted against the base.
 */
const PROJECTS: Record<string, string[]> = {
  'packages/core/vitest.config.ts': ['test/**/*.test.ts'],
  'packages/desktop/vitest.config.ts': ['src/renderer/**/*.test.ts', 'src/shared/**/*.test.ts', 'test/**/*.test.ts'],
  'packages/desktop/vitest.main.config.ts': ['src/main/**/*.test.ts'],
  'packages/editor/vitest.config.ts': ['test/**/*.test.ts'],
  'packages/importer/vitest.config.ts': ['test/**/*.test.ts'],
  'packages/mcp/vitest.config.ts': ['test/**/*.test.ts'],
  'packages/native/vitest.config.ts': ['test/**/*.test.ts'],
  'packages/sync/vitest.config.ts': ['test/**/*.test.ts'],
}

const SCRIPTS: Record<string, Record<string, string>> = {
  'package.json': {
    test: 'vitest run',
    'test:main': 'npm run test -w @slate/desktop',
    typecheck: 'tsc -p packages/core/tsconfig.json && tsc -p packages/editor/tsconfig.json && tsc -p tsconfig.json',
    lint: 'npm run lint:js && npm run lint:arch',
    'lint:js': 'tools/lint/node_modules/.bin/eslint . --max-warnings 0',
    'lint:arch': 'tools/lint/node_modules/.bin/depcruise packages --config .dependency-cruiser.cjs --output-type err',
    'lint:changed': 'node tools/lint/changed.mjs',
    guards: 'vitest run --config tools/guards/vitest.config.mts',
  },
  'packages/desktop/package.json': {
    test: 'cross-env ELECTRON_RUN_AS_NODE=1 electron ../../node_modules/vitest/vitest.mjs run --config vitest.main.config.ts',
  },
}

const HOW = 'test configuration is a guard: change it only on a guardrail branch the maintainer unlocked'

describe('test configuration', () => {
  it('every package with tests has a pinned vitest project', () => {
    const configs = readdirSync(join(ROOT, 'packages')).flatMap((p) => readdirSync(join(ROOT, 'packages', p)).filter((f) => /^vitest(\.\w+)?\.config\.[cm]?ts$/.test(f)).map((f) => `packages/${p}/${f}`))
    expect(configs.sort()).toEqual(Object.keys(PROJECTS).sort())
    expect(read('vitest.config.ts')).toContain("projects: ['packages/*/vitest.config.ts']")
  })

  it('each project includes exactly its pinned globs, excludes nothing and requires assertions', () => {
    const problems: string[] = []
    for (const [file, include] of Object.entries(PROJECTS)) {
      const text = read(file)
      const found = /include:\s*\[([^\]]*)\]/.exec(text)?.[1]?.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) ?? []
      if (JSON.stringify(found) !== JSON.stringify(include)) problems.push(`${file}: include ${JSON.stringify(found)}, pinned ${JSON.stringify(include)}`)
      for (const banned of ['exclude', 'passWithNoTests', 'allowOnly', 'bail', 'testNamePattern']) if (text.includes(banned)) problems.push(`${file}: no \`${banned}\``)
      if (!/requireAssertions:\s*true/.test(text)) problems.push(`${file}: needs expect: { requireAssertions: true }`)
    }
    expect(problems.map((p) => `${p} (${HOW})`)).toEqual([])
  })

  it('the scripts that run the checks are the pinned ones', () => {
    const problems: string[] = []
    for (const [file, scripts] of Object.entries(SCRIPTS)) {
      const actual = (JSON.parse(read(file)) as { scripts: Record<string, string> }).scripts
      for (const [name, value] of Object.entries(scripts)) if (actual[name] !== value) problems.push(`${file} scripts.${name} is ${JSON.stringify(actual[name])}`)
    }
    expect(problems.map((p) => `${p} (${HOW})`)).toEqual([])
  })
})

// A todo counts too: replacing a failing test with it.todo('… (C9)') keeps the case count (red team re-run 10a).
// runIf is a skipIf with the condition reversed, and a modifier taken as a value (`linux ? it : it.skip`) or
// chained (`it.skip.each`) skips as well, so every mention counts, called or not (C11).
const SKIP = /\b(?:it|test|describe)(?:\.\w+)*(?:\.(?:skip|skipIf|runIf|todo|fixme)\b|\[\s*['"`](?:skip|skipIf|runIf|todo|fixme)['"`]\s*\])/g
// `const { skip, todo: later } = it` takes skips out of a runner by destructuring: each one named counts.
const DESTRUCTURED = /\{([^{}]*)\}\s*=\s*(?:it|test|describe)\b/g
const MODIFIER = /\b(?:skip|skipIf|runIf|todo|fixme)\b/g
// A runner imported under another name or through a namespace hides its skips from the counts above; each such
// import counts as one (slate/tests-registered-unconditionally refuses them, so this only ever shrinks).
const RENAMED = /\bimport\s*(?:type\s+)?\{[^}]*\b(?:it|test|describe)\s+as\s+\w+[^}]*\}\s*from|\bimport\s+\*\s+as\s+\w+\s+from\s+['"](?:vitest|@playwright\/test|[^'"]*fixtures)['"]/g
/**
 * The names a file calls runners by (fix check 2, C11): it, test, describe, a renamed import, and transitively any
 * binding made from one (`const x = test.extend({})`, `const t = it`) or destructured from a runner module loaded
 * at run time (`const { it: t } = await import('vitest')`).
 */
export function runnerAliases(text: string): Set<string> {
  const names = new Set(['it', 'test', 'describe'])
  for (const m of text.matchAll(/\b(?:it|test|describe)\s+as\s+(\w+)/g)) if (/\bimport\b/.test(text.slice(Math.max(0, m.index - 200), m.index))) names.add(m[1]!)
  for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\(\s*['"](?:vitest|@playwright\/test|[^'"]*fixtures)['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const local = part.split(':').pop()!.trim()
      if (/^\w+$/.test(local)) names.add(local)
    }
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?(\w+)\b/g)) {
      if (names.has(m[2]!) && !names.has(m[1]!)) {
        names.add(m[1]!)
        grew = true
      }
    }
  }
  return names
}

export const countSkips = (text: string): number => {
  const extra = [...runnerAliases(text)].filter((n) => !['it', 'test', 'describe'].includes(n))
  // A skip on an alias counts like one on the runner itself.
  const aliasSkips = extra.length === 0 ? 0 : (text.match(new RegExp(`\\b(?:${extra.join('|')})(?:\\.\\w+)*\\.(?:skip|skipIf|runIf|todo|fixme)\\b`, 'g')) ?? []).length
  return (text.match(SKIP) ?? []).length + aliasSkips + (text.match(RENAMED) ?? []).length + [...text.matchAll(DESTRUCTURED)].reduce((n, m) => n + (m[1]!.match(MODIFIER) ?? []).length, 0)
}
const testFiles = (paths: string[]) => paths.filter((f) => /\.(test|spec)\.tsx?$/.test(f))

describe('ratchet: tests only grow', () => {
  const base = baseCommit()

  it('the skip counter sees every form (self-test)', () => {
    expect(countSkips("it.skip('a')\ndescribe.skipIf(x)('b')\ntest.todo('c')\nit.concurrent.skip('d')\nit('e')")).toBe(4)
    expect(countSkips("it.todo('T-STATIC-02 no node:crypto (C4)')")).toBe(1)
    // C11 bypasses: runIf in each form, a skip chosen as a value, and a chained skip.
    expect(countSkips("it.runIf(linux)('a')\ndescribe.runIf(x)('b')\ntest.concurrent.runIf(y)('c')")).toBe(3)
    expect(countSkips("const maybe = linux ? it : it.skip\nit.skip.each([1])('n')")).toBe(2)
    expect(countSkips("it.skipped('x')\ntest.skipper")).toBe(0)
    // Fix check 2 (C11): skips on runners made by .extend or loaded at run time count.
    expect(countSkips("import { test } from '@playwright/test'\nconst x = test.extend({})\nconst y = x\ny.skip('a')\nx.fixme('b')")).toBe(2)
    expect(countSkips("const { it: t } = await import('vitest')\nt.skip('a')")).toBe(1)
    // Fix check C11: renamed and namespace runner imports count.
    expect(countSkips("import { it as t } from 'vitest'\nimport { test as x } from './fixtures'\nimport * as v from 'vitest'\nimport { it } from 'vitest'\nit('reports it as deleted')")).toBe(3)
    // Review C11: destructured and computed skips count too.
    expect(countSkips("const { skip } = it\nconst { todo: later, runIf } = test\nit['skip']('a')\ndescribe[\"skipIf\"](x)")).toBe(5)
  })

  // Outside a checkout with history there is no base to compare with.
  it.skipIf(base === null)('no test file gained a skip or todo since the base', () => {
    const grown: string[] = []
    for (const file of testFiles(walk('packages', ['.ts', '.tsx']))) {
      const was = readAt(base!, file)
      const before = was === null ? 0 : countSkips(was)
      const now = countSkips(read(file))
      if (now > before) grown.push(`${file}: ${String(before)} → ${String(now)} skipped or todo`)
    }
    expect(grown.map((g) => `${g}: make the test run, or fix what it found; a skip is not a fix`)).toEqual([])
  })

  // As above.
  it.skipIf(base === null)('no package lost test files since the base', () => {
    const count = (paths: string[]) => {
      const out = new Map<string, number>()
      for (const f of testFiles(paths)) {
        const pkg = f.split('/').slice(0, 2).join('/')
        out.set(pkg, (out.get(pkg) ?? 0) + 1)
      }
      return out
    }
    const before = count(git(['ls-tree', '-r', '--name-only', base!, 'packages']).split('\n'))
    const now = count(walk('packages', ['.ts', '.tsx']))
    const lost = [...before].filter(([pkg, n]) => (now.get(pkg) ?? 0) < n).map(([pkg, n]) => `${pkg}: ${String(n)} → ${String(now.get(pkg) ?? 0)} test files`)
    expect(lost).toEqual([])
  })
})
