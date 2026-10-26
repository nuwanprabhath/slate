import { defineConfig } from 'vitest/config'

// Runs under Electron's Node (ELECTRON_RUN_AS_NODE=1): the main process's runtime, with slate_native.node (SQLCipher inside).
export default defineConfig({ test: { environment: 'node', expect: { requireAssertions: true }, include: ['src/main/**/*.test.ts'], setupFiles: ['src/main/testSetup.ts'] } })
