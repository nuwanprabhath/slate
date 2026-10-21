import { defineConfig } from 'vitest/config'

// Runs under Electron's Node (ELECTRON_RUN_AS_NODE=1) so better-sqlite3's Electron build loads.
export default defineConfig({ test: { environment: 'node', include: ['src/main/**/*.test.ts'] } })
