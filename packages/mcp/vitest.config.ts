import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'mcp', environment: 'node', expect: { requireAssertions: true }, include: ['test/**/*.test.ts'] } })
