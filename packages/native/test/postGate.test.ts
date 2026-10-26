// C6 (audit S-1, S-2, S-6): no cryptographic service runs before the power-up self-test passed. The gate and
// the error state are one-way for a process, so every case runs in a child (postGateChild.mjs).
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function run(mode: 'gated' | 'failed' | 'ungated'): Record<string, unknown> {
  const r = spawnSync(process.execPath, [join(__dirname, 'postGateChild.mjs'), mode], { encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as Record<string, unknown>
}

describe('the power-up self-test gate (C6)', () => {
  it('a gated module refuses every service until a self-test session passed, then serves the process', () => {
    expect(run('gated')).toEqual({
      beforePost: 'SCC_2',
      keyBeforePost: 'SCC_2',
      passedBefore: false,
      begin: 'ran',
      inPost: 'ran',
      end: 'ran',
      afterPost: 'ran',
      passedAfter: true,
      errorState: false,
      beginAgain: 'ran',
    })
  })

  it('a failed self-test enters the error state: every key destroyed, every connection closed, no service, no new session', () => {
    expect(run('failed')).toEqual({
      beforePost: 'SCC_2',
      keyBeforePost: 'SCC_2',
      passedBefore: false,
      begin: 'ran',
      inPost: 'ran',
      end: 'SCC_12',
      dbOpen: false,
      liveHandles: 0,
      afterPost: 'SCC_12',
      passedAfter: false,
      errorState: true,
      beginAgain: 'SCC_12',
    })
  })

  it('a process that never gates (tests, the CLIs) is served after init, as before', () => {
    expect(run('ungated')).toMatchObject({ beforePost: 'ran', passedBefore: true, begin: 'ran', end: 'ran', passedAfter: true })
  })
})
