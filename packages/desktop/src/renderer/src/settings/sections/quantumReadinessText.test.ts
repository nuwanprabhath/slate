import { describe, expect, it } from 'vitest'
import type { PqReadiness, TransportObservation } from '../../../../shared/api'
import { quantumReadinessText, remoteLabel } from './quantumReadinessText'

const obs = (over: Partial<TransportObservation>): TransportObservation => ({ remote: 'git-ssh:github.com', transport: 'ssh', kex: 'mlkem768x25519-sha256', pq: 'hybrid', source: 'probe', at: 1, ...over })
const base: PqReadiness = { atRest: 'symmetric-256', vault: { kind: 'none' }, transports: [], updateSignature: 'ed25519', plaintextSync: false, requirePq: false }
const fixtures: Record<string, PqReadiness> = {
  v3Hybrid: { ...base, vault: { kind: 'header', version: 3, upgrade: 'done', blockingDevices: [] }, transports: [obs({})], updateSignature: 'ml-dsa-65+ed25519' },
  v2WaitingClassical: {
    ...base,
    vault: { kind: 'header', version: 2, upgrade: 'waiting-devices', blockingDevices: ['Laptop', 'Desk'] },
    transports: [obs({ pq: 'classical', kex: 'ecdh-sha2-nistp256' })],
  },
  v1: { ...base, vault: { kind: 'header', version: 1, upgrade: 'offer-v1', blockingDevices: [] } },
  plaintextSync: { ...base, plaintextSync: true },
}
const value = (r: PqReadiness, id: string) => quantumReadinessText(r).rows.find((x) => x.id === id)

describe('quantumReadinessText', () => {
  it('T-PQ-D1-01: v3 with a hybrid connection', () => {
    const t = quantumReadinessText(fixtures['v3Hybrid']!)
    expect(value(fixtures['v3Hybrid']!, 'at-rest')?.value).toBe('AES-256: resistant to known quantum attacks')
    expect(value(fixtures['v3Hybrid']!, 'vault')?.value).toBe('Current')
    expect(t.transports).toEqual([{ remote: 'github.com (git over SSH)', text: 'Post-quantum key exchange (ML-KEM)' }])
    expect(value(fixtures['v3Hybrid']!, 'signature')?.value).toBe('ML-DSA-65 + Ed25519 (post-quantum)')
    expect(t.notice).toBeNull()
    expect(t.vaultAction).toBeNull()
  })
  it('T-PQ-D1-01: v2 waiting for devices, classical connection', () => {
    const r = fixtures['v2WaitingClassical']!
    const t = quantumReadinessText(r)
    expect(value(r, 'vault')?.value).toBe('Waiting for 2 devices to update to Slate 0.4 or newer')
    expect(t.transports[0]?.text).toBe('Classical key exchange: the server does not offer post-quantum')
    expect(value(r, 'signature')?.value).toBe('Ed25519')
  })
  it('T-PQ-D1-01: other v2 states, a lone device and a computer that cannot', () => {
    const waiting1: PqReadiness = { ...base, vault: { kind: 'header', version: 2, upgrade: 'waiting-devices', blockingDevices: ['Laptop'] } }
    expect(value(waiting1, 'vault')?.value).toBe('Waiting for 1 device to update to Slate 0.4 or newer')
    const running: PqReadiness = { ...base, vault: { kind: 'header', version: 2, upgrade: 'running', blockingDevices: [] } }
    expect(value(running, 'vault')?.value).toBe('Updating…')
    const local = quantumReadinessText({ ...base, transports: [obs({ pq: 'classical', kex: null }), obs({ remote: 'b', pq: 'unknown', kex: null })] })
    expect(local.transports.map((x) => x.text)).toEqual(["Classical key exchange: this computer's ssh/git cannot do post-quantum", 'Not checked'])
  })
  it('T-PQ-D1-01: remotes read as host and kind', () => {
    expect(remoteLabel('git-ssh:github.com')).toBe('github.com (git over SSH)')
    expect(remoteLabel('git-https:github.com')).toBe('github.com (git over HTTPS)')
    expect(remoteLabel('git-ssh:git.example.com:2222')).toBe('git.example.com:2222 (git over SSH)')
    expect(remoteLabel('onedrive:graph.microsoft.com')).toBe('graph.microsoft.com (OneDrive)')
    expect(remoteLabel('odd')).toBe('odd')
  })
  it('T-PQ-D1-01: v1 offers the existing upgrade', () => {
    const t = quantumReadinessText(fixtures['v1']!)
    expect(value(fixtures['v1']!, 'vault')?.value).toBe('Version 1, an older format')
    expect(t.vaultAction).toBe('Upgrade encryption format…')
  })
  it('T-PQ-D1-01: no vault, nothing checked, and plaintext sync', () => {
    const t = quantumReadinessText(fixtures['plaintextSync']!)
    expect(value(base, 'vault')?.value).toBe('Not encrypted')
    expect(t.transports).toEqual([])
    expect(t.notice?.text).toMatch(/^Your notes sync unencrypted\./)
    expect(t.notice?.action).toBe('Encrypt my notes…')
    expect(quantumReadinessText(base).notice).toBeNull()
  })
  it('T-PQ-D1-02: no overclaiming word anywhere', () => {
    const all: string[] = []
    for (const r of [...Object.values(fixtures), base]) {
      const t = quantumReadinessText(r)
      all.push(...t.rows.flatMap((x) => [x.label, x.value]), ...t.transports.map((x) => x.text), t.notice?.text ?? '', t.vaultAction ?? '')
    }
    for (const s of all) expect(s).not.toMatch(/quantum-proof|unbreakable|validated|certified/i)
  })
})
