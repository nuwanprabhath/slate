import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

// Every test launches its own app on its own data folder under the run's temp root, so most specs run
// side by side. Two kinds cannot:
// - `os-shared`: specs that use the system clipboard (one per machine) and quit-clean, which reads every
//   Electron crash report on the Mac. One at a time, beside the parallel ones. The clipboard specs are found,
//   not listed: a spec is one if it, or a file it imports from e2e (imageHelpers' boxWithImage), calls the
//   clipboard or presses copy, cut or paste. On Linux the specs that drag join them: a drag holds pointer capture,
//   which Chromium backs with an X pointer grab, and two apps on one display (CI's xvfb) take it from each other
//   mid-drag. The drag is in the spec's own text (drag(, mouse.down(), not followed through canvasHelpers, which
//   every canvas spec imports.
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

const DRAG = /\bdrag\(|mouse\.down\(|\.dragTo\(/
const sharesTheOs = (f: string): boolean => usesClipboard(f) || (process.platform === 'linux' && DRAG.test(readFileSync(f, 'utf8')))
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
