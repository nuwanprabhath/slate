import { defineConfig } from '@playwright/test'

// Every test launches its own app on its own data folder under the run's temp root, so most specs run
// side by side. Two kinds cannot:
// - `os-shared`: specs that use the system clipboard (one per machine) and quit-clean, which reads
//   every Electron crash report on the Mac. One at a time, beside the parallel ones.
// - `perf`: the performance budgets measure wall-clock time, so they run last, alone.
const OS_SHARED = [
  'box-clipboard.spec.ts',
  'box-empty-space.spec.ts',
  'click-to-type.spec.ts',
  'copy-images.spec.ts',
  'editor-bugs.spec.ts',
  'image-drag.spec.ts',
  'links.spec.ts',
  'selftest.spec.ts',
  'spec/clipboard.spec.ts',
  'text-menu.spec.ts',
  'todo-align-script.spec.ts',
  'toolbar.spec.ts',
  'ui/canvas.ui.spec.ts',
  'update.spec.ts',
  'quit-clean.spec.ts',
].map((f) => `**/e2e/${f}`)
const PERF = ['**/e2e/spec/perf*.spec.ts', '**/e2e/perf-*.spec.ts']

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: process.env.CI ? 2 : 4,
  reporter: 'list',
  globalSetup: './e2e/tmpRoot.ts',
  projects: [
    { name: 'parallel', testIgnore: [...OS_SHARED, ...PERF] },
    { name: 'os-shared', testMatch: OS_SHARED, workers: 1 },
    { name: 'perf', testMatch: PERF, workers: 1, dependencies: ['parallel', 'os-shared'] },
  ],
})
