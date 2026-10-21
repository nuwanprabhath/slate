import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'mcp', environment: 'node', include: ['test/**/*.test.ts'] } })
