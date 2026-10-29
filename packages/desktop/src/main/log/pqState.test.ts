import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TransportObservation } from '../../shared/api'
import { Logger } from './logger'
import { logPqState, pqDiagnosticFields } from './pqState'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const obs = (remote: string): TransportObservation => ({ remote, transport: 'ssh', kex: 'mlkem768x25519-sha256', pq: 'hybrid', source: 'probe', at: 1700000000000 })

describe('the post-quantum state in the diagnostic log (PQ-D3)', () => {
  it('T-PQ-D3-02: carries the header version and each remote as a host only, through the redacting logger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-pqstate-'))
    dirs.push(dir)
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 5, home: '/Users/ann' })
    logPqState(l.scoped('app'), {
      vaultHeaderVersion: 3,
      transports: [obs('git-ssh:github.com'), obs('git-ssh:ann:ghp_0123456789abcdef0123456789abcdef0123@github.com/ann/notes.git')],
    })
    const text = readFileSync(join(dir, 'slate.log'), 'utf8')
    expect(text).toContain('"vaultHeaderVersion":3')
    expect(text).toContain('"remote":"git-ssh:github.com"')
    expect(text).not.toMatch(/ghp_|\/ann\/notes|@github/)
    expect(text).not.toMatch(/\/Users\/ann/)
  })

  it('T-PQ-D3-02: no vault is null, and no transports is an empty list', () => {
    expect(pqDiagnosticFields({ vaultHeaderVersion: null, transports: [] })).toEqual({ vaultHeaderVersion: null, transports: [] })
  })
})
