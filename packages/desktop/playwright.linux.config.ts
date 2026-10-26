import { defineConfig } from '@playwright/test'

// Audit §6.3 T-ZERO-04 and T-ZERO-06 (C7): memory evidence that needs Linux, root for the memory scan and a
// core pattern set by CI (.github/workflows/ci.yml, "Memory evidence"). `npm run e2e` never matches these files.
export default defineConfig({ testDir: 'e2e', testMatch: '**/*.linux.ts', timeout: 60_000, workers: 1, reporter: 'list', globalSetup: './e2e/tmpRoot.ts' })
