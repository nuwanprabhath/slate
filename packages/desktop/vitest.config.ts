import { defineProject } from 'vitest/config'

// Renderer logic that needs no DOM (layout maths, storage migration). `npm test` picks this up.
export default defineProject({ test: { name: 'desktop-renderer', environment: 'node', include: ['src/renderer/**/*.test.ts'] } })
