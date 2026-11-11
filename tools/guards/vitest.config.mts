import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// `npm run guards`: the guard tests (tools/guards) and the lint rules' own tests
// (tools/eslint-rules). Run from the repo root, so paths in them are repo-relative.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    name: 'guards',
    environment: 'node',
    include: ['tools/guards/**/*.test.ts', 'tools/eslint-rules/**/*.test.mjs'],
    testTimeout: 60_000,
    // SLATE_TEST_REPORT: see vitest.config.ts at the repo root (review F9, the release's test evidence).
    ...(process.env.SLATE_TEST_REPORT ? { reporters: ['default', ['json', { outputFile: process.env.SLATE_TEST_REPORT }]] } : {}),
  },
})
