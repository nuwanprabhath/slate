import { defineConfig } from 'vitest/config'

// Picks up packages/*/vitest.config.ts (core, editor). Desktop main-process tests use
// vitest.main.config.ts instead: they need Electron's Node ABI and run via `npm run test:main`.
// SLATE_TEST_REPORT: the machine-readable results CI keeps as the release's evidence that each traced test
// ran and passed on this commit (scripts/traceability.mjs --verify-run, review F9). Unset locally, so a run
// writes nothing.
const report = process.env.SLATE_TEST_REPORT

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    ...(report ? { reporters: ['default', ['json', { outputFile: report }]] } : {}),
  },
})
