import { defineProject } from 'vitest/config'

// Pure renderer helpers (layout maths, sync age text). Main-process tests use vitest.main.config.ts instead.
export default defineProject({ test: { name: 'desktop', environment: 'node', include: ['src/renderer/**/*.test.ts'] } })
