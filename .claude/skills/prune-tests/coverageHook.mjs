// A Vitest setup file for overlap.mjs: Vitest kills a forked worker before Node writes its
// NODE_V8_COVERAGE, so each test file writes it itself once its tests have run.
import { takeCoverage } from 'node:v8'
import { afterAll } from 'vitest'

afterAll(() => { takeCoverage() })
