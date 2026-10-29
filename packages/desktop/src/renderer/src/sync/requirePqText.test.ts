import { describe, expect, it } from 'vitest'
import type { TransportObservation } from '../../../shared/api'
import { classicalWarning, requirePqAvailability, REQUIRE_PQ_LABEL } from './requirePqText'

const obs = (remote: string, pq: TransportObservation['pq']): TransportObservation => ({ remote, transport: 'ssh', kex: pq === 'hybrid' ? 'mlkem768x25519-sha256' : 'ecdh-sha2-nistp256', pq, source: 'probe', at: 1 })

describe('requirePqAvailability', () => {
  it('T-PQ-D2-04: OneDrive and an HTTPS remote are disabled with the refusal main gives', () => {
    expect(requirePqAvailability('onedrive', '')).toEqual({ enabled: false, reason: 'Microsoft OneDrive does not offer post-quantum key exchange yet' })
    expect(requirePqAvailability('git', 'https://github.com/a/b.git')).toEqual({ enabled: false, reason: 'Use an SSH remote for post-quantum key exchange' })
  })
  it('T-PQ-D2-04: SSH remotes are enabled, in both spellings', () => {
    expect(requirePqAvailability('git', 'git@github.com:a/b.git')).toEqual({ enabled: true })
    expect(requirePqAvailability('git', 'ssh://git@host.example/a/b.git')).toEqual({ enabled: true })
  })
  it('T-PQ-D2-04: no sync, or no usable remote yet, offers nothing to turn on', () => {
    expect(requirePqAvailability(null, '')).toBeNull()
    expect(requirePqAvailability('git', '')).toEqual({ enabled: false, reason: 'Enter an SSH repository URL to use this' })
    expect(requirePqAvailability('git', '/tmp/bare.git')).toEqual({ enabled: false, reason: 'Enter an SSH repository URL to use this' })
  })
})

describe('classicalWarning', () => {
  it('T-PQ-D2-05: names a git SSH remote whose last observation is classical', () => {
    const w = classicalWarning([obs('git-https:github.com', 'classical'), obs('git-ssh:github.com', 'classical')])
    expect(w).toContain('github.com (git over SSH)')
    expect(w).toContain('classical')
  })
  it('T-PQ-D2-05: hybrid or unknown observations warn of nothing', () => {
    expect(classicalWarning([obs('git-ssh:github.com', 'hybrid')])).toBeNull()
    expect(classicalWarning([])).toBeNull()
  })
  it('T-PQ-D2-05: no string claims more than the state shows', () => {
    const all = [REQUIRE_PQ_LABEL, classicalWarning([obs('git-ssh:h', 'classical')]) ?? '', JSON.stringify(requirePqAvailability('onedrive', ''))]
    for (const s of all) expect(s).not.toMatch(/quantum-proof|unbreakable|validated|certified|safe from/i)
  })
})
