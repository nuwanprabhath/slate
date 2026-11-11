import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

// Every test launches its own app on its own data folder under the run's temp root, so most specs run
// side by side. Two kinds cannot:
// - `os-shared`: specs that share something there is one of per machine. One at a time, beside the parallel
//   ones. quit-clean reads every Electron crash report on the Mac, so it is always here. On macOS the
//   clipboard is one per machine too, and the specs that use it are found rather than listed: a spec is one
//   if it, or a file it imports from e2e (imageHelpers' boxWithImage), calls the clipboard or presses copy,
//   cut or paste. On Linux nothing else belongs here: each worker runs on its own X display (the `display`
//   fixture in e2e/fixtures.ts), which gives it its own X selection for the clipboard and its own pointer,
//   so a drag's pointer grab and a copy cannot reach another worker's app. That replaces searching spec
//   text for a drag, which only ever found the failure classes that had already failed in CI.
// - `perf`: the performance budgets measure wall-clock time, so `npm run e2e` (scripts/e2e.mjs) runs them
//   after the other two, alone.
const E2E = join(__dirname, 'e2e')
const CLIPBOARD = /clipboard\.(?:write|read|clear|has|availableFormats)|navigator\.clipboard|webContents\.(?:copy|cut|paste)\w*\(|execCommand\(\s*['"`](?:copy|cut|paste)|(?:Meta|Control|ControlOrMeta|\$\{MOD\}|Mod)\+(?:Shift\+)?[cvxCVX]\b|['"`](?:Copy|Cut|Paste)['"`]/

function usesClipboard(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file) || !existsSync(file)) return false
  seen.add(file)
  const text = readFileSync(file, 'utf8')
  if (CLIPBOARD.test(text)) return true
  for (const [, spec] of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
    const target = resolve(dirname(file), spec!)
    if (usesClipboard(existsSync(`${target}.ts`) ? `${target}.ts` : target, seen)) return true
  }
  return false
}

const specs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? specs(join(dir, e.name)) : e.name.endsWith('.spec.ts') ? [join(dir, e.name)] : []))

const sharesTheOs = (f: string): boolean => process.platform !== 'linux' && usesClipboard(f)
const OS_SHARED = [...specs(E2E).filter(sharesTheOs).map((f) => relative(E2E, f)), 'quit-clean.spec.ts'].map((f) => `**/e2e/${f}`)
const PERF = ['**/e2e/spec/perf*.spec.ts', '**/e2e/perf-*.spec.ts']

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: process.env.CI ? 2 : 4,
  // SLATE_TEST_REPORT: see vitest.config.ts at the repo root (review F9, the release's test evidence).
  // scripts/e2e.mjs gives each of its two Playwright passes its own file, so neither overwrites the other.
  reporter: process.env.SLATE_TEST_REPORT ? [['list'], ['json', { outputFile: process.env.SLATE_TEST_REPORT }]] : 'list',
  globalSetup: './e2e/tmpRoot.ts',
  projects: [
    { name: 'parallel', testIgnore: [...OS_SHARED, ...PERF] },
    { name: 'os-shared', testMatch: OS_SHARED, workers: 1 },
    { name: 'perf', testMatch: PERF, workers: 1 },
  ],
})
