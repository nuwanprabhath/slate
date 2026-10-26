import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMemoryProbes, type MemoryProbeGlobals } from './memoryProbes'
import { scrubTestHooks, TEST_HOOK_VARS } from './testHooks'

afterEach(() => vi.unstubAllEnvs())

describe('memory probes for the T-ZERO e2e tests (C7)', () => {
  it('an e2e run with the hooks set gets a full GC and a heap snapshot', () => {
    vi.stubEnv('SLATE_TEST_EXPOSE_GC', '1')
    vi.stubEnv('SLATE_TEST_HEAP_SNAPSHOT', '1')
    const target: MemoryProbeGlobals = {}
    installMemoryProbes(true, target)
    expect(typeof target.gc).toBe('function')
    expect(() => target.gc!()).not.toThrow()
    const dir = mkdtempSync(join(tmpdir(), 'slate-heap-'))
    try {
      const file = target.__slateHeapSnapshot!(join(dir, 'h.heapsnapshot'))
      expect(existsSync(file)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('nothing outside an e2e run, nothing without the hooks, and a packaged app scrubs the hooks', () => {
    vi.stubEnv('SLATE_TEST_EXPOSE_GC', '1')
    vi.stubEnv('SLATE_TEST_HEAP_SNAPSHOT', '1')
    const notE2E: MemoryProbeGlobals = {}
    installMemoryProbes(false, notE2E)
    expect(notE2E).toEqual({})
    vi.unstubAllEnvs()
    const noHooks: MemoryProbeGlobals = {}
    installMemoryProbes(true, noHooks)
    expect(noHooks).toEqual({})
    expect(TEST_HOOK_VARS).toEqual(expect.arrayContaining(['SLATE_TEST_EXPOSE_GC', 'SLATE_TEST_HEAP_SNAPSHOT']))
    const packaged: NodeJS.ProcessEnv = { SLATE_TEST_EXPOSE_GC: '1', SLATE_TEST_HEAP_SNAPSHOT: '1' }
    scrubTestHooks(packaged, true, true)
    expect(packaged).toEqual({})
  })
})
