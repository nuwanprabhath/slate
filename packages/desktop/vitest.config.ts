import { defineProject } from 'vitest/config'

// Pure renderer and shared helpers (layout maths, sync age text, the settings schema). Main-process tests use vitest.main.config.ts instead.
export default defineProject({ test: { name: 'desktop', environment: 'node', expect: { requireAssertions: true }, include: ['src/renderer/**/*.test.ts', 'src/shared/**/*.test.ts', 'test/**/*.test.ts'] } })
