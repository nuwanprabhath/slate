import { defineConfig } from 'vitest/config'

// Picks up packages/*/vitest.config.ts (core, editor). Desktop main-process tests use
// vitest.main.config.ts instead: they need Electron's Node ABI and run via `npm run test:main`.
export default defineConfig({ test: { projects: ['packages/*/vitest.config.ts'] } })
