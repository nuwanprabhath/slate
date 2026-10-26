// Audit §4.2, C2 M2, C6, D-2: a module that never initialised, or whose init failed half-way, fails CLOSED.
// status() and the other read-only services report the state; they never crash the process (the packaged
// Linux build without a provider used to SIGSEGV in status() -> CRYPTO_secure_used on an uninitialised heap).
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function run(mode: string): Record<string, unknown> {
  const r = spawnSync(process.execPath, [join(__dirname, 'initStateChild.mjs'), mode], { encoding: 'utf8' })
  expect(r.signal, r.stderr).toBeNull()
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as Record<string, unknown>
}

const notReady = {
  ready: false,
  fipsActive: false,
  postPassed: false,
  liveHandles: 0,
  secureHeapUsed: 0,
  fipsModule: null,
}

describe('the read-only services in every init state', () => {
  it('before init: status reports not ready, every service refuses with SCC_2', () => {
    const r = run('fresh')
    expect(r.status).toMatchObject({ ...notReady, errorState: false })
    expect(r).toMatchObject({ zeroize: 0, random: 'SCC_2', sha256: 'SCC_2', keyRandom: 'SCC_2', postBegin: 'SCC_2', statusAgain: false })
  })

  it('enterErrorState before any init (the packaged no-provider path): error state, no crash', () => {
    const r = run('errorBeforeInit')
    expect(r.enter).toBe('ran')
    expect(r.status).toMatchObject({ ...notReady, errorState: true })
    expect(r).toMatchObject({ random: 'SCC_12', sha256: 'SCC_12', keyRandom: 'SCC_12', postBegin: 'SCC_12', statusAgain: true })
  })

  it('init with a missing provider fails typed and leaves the module in the error state', () => {
    const r = run('missing')
    expect(r.init).toMatch(/^SCC_\d+$/)
    expect(r.status).toMatchObject({ ...notReady, errorState: true })
    expect(r).toMatchObject({ random: 'SCC_12', keyRandom: 'SCC_12', statusAgain: true })
  })

  it('init with a provider that does not match the pin fails with SCC_15 and the error state', () => {
    const r = run('wrongPin')
    expect(r.init).toBe('SCC_15')
    expect(r.status).toMatchObject({ ...notReady, errorState: true })
    expect(r).toMatchObject({ random: 'SCC_12', keyRandom: 'SCC_12', statusAgain: true })
  })
})
