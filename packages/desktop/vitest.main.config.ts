import { defineConfig } from 'vitest/config'

// Runs under Electron's Node (ELECTRON_RUN_AS_NODE=1): the main process's runtime, with slate_native.node (SQLCipher inside).
// SLATE_TEST_REPORT: see vitest.config.ts at the repo root (review F9, the release's test evidence).
const report = process.env.SLATE_TEST_REPORT

export default defineConfig({
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    include: ['src/main/**/*.test.ts'],
    setupFiles: ['src/main/testSetup.ts'],
    ...(report ? { reporters: ['default', ['json', { outputFile: report }]] } : {}),
  },
})
