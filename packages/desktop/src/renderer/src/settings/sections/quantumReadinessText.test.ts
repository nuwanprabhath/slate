import { describe, expect, it } from 'vitest'
import type { PqReadiness, TransportObservation } from '../../../../shared/api'
import { checkedAtText, checkStatusText, quantumReadinessText, remoteHost, remoteLabel } from './quantumReadinessText'

const obs = (over: Partial<TransportObservation>): TransportObservation => ({ remote: 'git-ssh:github.com', transport: 'ssh', kex: 'mlkem768x25519-sha256', pq: 'hybrid', source: 'probe', at: 1, ...over })
const base: PqReadiness = { atRest: 'symmetric-256', vault: { kind: 'none' }, transports: [], updateSignature: 'ed25519', plaintextSync: false, requirePq: false }
const fixtures: Record<string, PqReadiness> = {
  v3Hybrid: { ...base, vault: { kind: 'header', version: 3, upgrade: 'done' }, transports: [obs({})], updateSignature: 'ml-dsa-65+ed25519' },
  v2WaitingClassical: {
    ...base,
    vault: { kind: 'header', version: 2, upgrade: 'waiting-devices', waiting: { reason: 'devices', devices: ['Laptop', 'Desk'] } },
    transports: [obs({ pq: 'classical', kex: 'ecdh-sha2-nistp256' })],
  },
  v1: { ...base, vault: { kind: 'header', version: 1, upgrade: 'offer-v1' } },
  plaintextSync: { ...base, plaintextSync: true },
}
const value = (r: PqReadiness, id: string) => quantumReadinessText(r).rows.find((x) => x.id === id)

describe('quantumReadinessText', () => {
  it('T-PQ-D1-01: v3 with a hybrid connection', () => {
    const t = quantumReadinessText(fixtures['v3Hybrid']!)
    expect(value(fixtures['v3Hybrid']!, 'at-rest')?.value).toBe('AES-256: resistant to known quantum attacks')
    expect(value(fixtures['v3Hybrid']!, 'vault')?.value).toBe('Current')
    expect(t.transports).toEqual([{ remote: 'github.com (git over SSH)', text: 'Post-quantum key exchange (ML-KEM)', detail: expect.stringMatching(/^mlkem768x25519-sha256 · checked /) as unknown }])
    expect(value(fixtures['v3Hybrid']!, 'signature')?.value).toBe('ML-DSA-65 + Ed25519 (post-quantum)')
    expect(t.notice).toBeNull()
    expect(t.vaultAction).toBeNull()
  })
  it('T-PQ-D1-01: v2 waiting for devices, classical connection', () => {
    const r = fixtures['v2WaitingClassical']!
    const t = quantumReadinessText(r)
    expect(value(r, 'vault')?.value).toBe('Waiting for 2 devices to update to Slate 0.4 or newer: "Laptop", "Desk"')
    expect(t.transports[0]?.text).toBe('Classical key exchange: the server does not offer post-quantum')
    expect(value(r, 'signature')?.value).toBe('Ed25519')
  })
  it('T-PQ-D1-01: other v2 states, a lone device and a computer that cannot', () => {
    const waiting1: PqReadiness = { ...base, vault: { kind: 'header', version: 2, upgrade: 'waiting-devices', waiting: { reason: 'devices', devices: ['Laptop'] } } }
    expect(value(waiting1, 'vault')?.value).toBe('Waiting for "Laptop" to update to Slate 0.4 or newer')
    const running: PqReadiness = { ...base, vault: { kind: 'header', version: 2, upgrade: 'running' } }
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
      all.push(...t.rows.flatMap((x) => [x.label, x.value, x.help ?? '']), ...t.transports.flatMap((x) => [x.text, x.detail]), t.notice?.text ?? '', t.vaultAction ?? '')
    }
    for (const s of all) expect(s).not.toMatch(/quantum-proof|unbreakable|validated|certified/i)
  })

  const waitingVault = (waiting: Extract<PqReadiness['vault'], { kind: 'header' }>['waiting']): PqReadiness => ({ ...base, vault: { kind: 'header', version: 2, upgrade: 'waiting-devices', ...(waiting ? { waiting } : {}) } })
  const READY_HELP = 'This computer is ready. The format updates by itself once every device that syncs these notes runs Slate 0.4 or newer.'

  it('waiting for one device names it, and says this computer is ready', () => {
    const r = waitingVault({ reason: 'devices', devices: ['nuwan-ubuntu'] })
    expect(value(r, 'vault')?.value).toBe('Waiting for "nuwan-ubuntu" to update to Slate 0.4 or newer')
    expect(value(r, 'vault')?.help).toBe(READY_HELP)
  })
  it('waiting for two devices names both; more than three names the first three and counts the rest', () => {
    expect(value(waitingVault({ reason: 'devices', devices: ['a', 'b'] }), 'vault')?.value).toBe('Waiting for 2 devices to update to Slate 0.4 or newer: "a", "b"')
    expect(value(waitingVault({ reason: 'devices', devices: ['a', 'b', 'c'] }), 'vault')?.value).toBe('Waiting for 3 devices to update to Slate 0.4 or newer: "a", "b", "c"')
    const five = waitingVault({ reason: 'devices', devices: ['a', 'b', 'c', 'd', 'e'] })
    expect(value(five, 'vault')?.value).toBe('Waiting for 5 devices to update to Slate 0.4 or newer: "a", "b", "c" and 2 more')
    expect(value(five, 'vault')?.help).toBe(READY_HELP)
  })
  it('waiting with sync off, or with a device list it could not read, says that and counts no device', () => {
    const off = waitingVault({ reason: 'sync-off' })
    expect(value(off, 'vault')?.value).toBe('Waiting for sync: turn it on so Slate can check your other devices')
    expect(value(off, 'vault')?.help).toBe(READY_HELP)
    expect(value(waitingVault({ reason: 'devices-unreadable' }), 'vault')?.value).toBe('Waiting: Slate could not read your device list. It tries again after the next sync.')
    expect(value(fixtures['v3Hybrid']!, 'vault')?.help).toBeUndefined()
  })

  it('the observation line names the key exchange and when it was seen: the time today, the date too before today', () => {
    const now = new Date(2026, 9, 29, 16, 30).getTime()
    expect(checkedAtText(new Date(2026, 9, 29, 14, 5).getTime(), now, 'en-GB')).toBe('14:05')
    expect(checkedAtText(new Date(2026, 9, 27, 9, 0).getTime(), now, 'en-GB')).toBe('27 Oct, 09:00')
    const t = quantumReadinessText({ ...base, transports: [obs({ at: new Date(2026, 9, 29, 14, 5).getTime() })] }, now, 'en-GB')
    expect(t.transports[0]?.detail).toBe('mlkem768x25519-sha256 · checked 14:05')
    // Classical: the explanation stays and the key exchange is named; a connection that never negotiated names none.
    const classical = quantumReadinessText({ ...base, transports: [obs({ pq: 'classical', kex: 'ecdh-sha2-nistp256', at: now }), obs({ remote: 'x', pq: 'classical', kex: null, at: now })] }, now, 'en-GB')
    expect(classical.transports.map((x) => [x.text, x.detail])).toEqual([
      ['Classical key exchange: the server does not offer post-quantum', 'ecdh-sha2-nistp256 · checked 16:30'],
      ["Classical key exchange: this computer's ssh/git cannot do post-quantum", 'checked 16:30'],
    ])
  })

  describe('the Check now status line', () => {
    const git = { enabled: true, provider: 'git' as const, remote: 'git@github.com:nuwan/notes.git' }
    const off = { enabled: false, provider: null }
    it('never checked', () => {
      expect(checkStatusText({ kind: 'idle' }, { sync: git, transports: [] })).toBe('Not checked yet')
      expect(checkStatusText({ kind: 'idle' }, { sync: git, transports: [obs({})] })).toBe('')
    })
    it('busy: names the host it connects to, or says what it does while the host is not known', () => {
      expect(checkStatusText({ kind: 'busy' }, { sync: git, transports: [] })).toBe('Connecting to github.com…')
      expect(checkStatusText({ kind: 'busy' }, { sync: null, transports: [obs({ remote: 'git-ssh:git.example.com:2222' })] })).toBe('Connecting to git.example.com:2222…')
      expect(checkStatusText({ kind: 'busy' }, { sync: { enabled: true, provider: 'onedrive' }, transports: [] })).toBe('Connecting to OneDrive…')
      expect(checkStatusText({ kind: 'busy' }, { sync: null, transports: [] })).toBe('Checking your sync connection…')
    })
    it('checked: says so even when the answer is the same as before', () => {
      expect(checkStatusText({ kind: 'done', found: 1 }, { sync: git, transports: [obs({})] })).toBe('Checked just now')
    })
    it('nothing to check: sync off, a sync folder on this computer, or a remote that never answered', () => {
      expect(checkStatusText({ kind: 'done', found: 0 }, { sync: off, transports: [] })).toBe('Nothing to check: sync is off')
      expect(checkStatusText({ kind: 'done', found: 0 }, { sync: null, transports: [] })).toBe('Nothing to check: sync is off')
      expect(checkStatusText({ kind: 'done', found: 0 }, { sync: { ...git, remote: '/Users/nuwan/notes.git' }, transports: [] })).toBe('Nothing to check: your sync folder is on this computer')
      expect(checkStatusText({ kind: 'done', found: 0 }, { sync: { ...git, remote: 'file:///srv/notes.git' }, transports: [] })).toBe('Nothing to check: your sync folder is on this computer')
      expect(checkStatusText({ kind: 'done', found: 0 }, { sync: git, transports: [] })).toBe('Nothing to check: Slate could not reach github.com')
    })
    it('error: the message, as before', () => {
      expect(checkStatusText({ kind: 'error', message: 'The transport probe runs only while the notes are open' }, { sync: git, transports: [] })).toBe('The transport probe runs only while the notes are open')
    })
    it('reads the host of every remote form git takes', () => {
      expect(remoteHost('git@github.com:nuwan/notes.git')).toBe('github.com')
      expect(remoteHost('ssh://git@git.example.com:2222/notes.git')).toBe('git.example.com')
      expect(remoteHost('https://user@gitlab.com/n/notes.git')).toBe('gitlab.com')
      expect(remoteHost('/Users/nuwan/notes.git')).toBeNull()
      expect(remoteHost('file:///srv/notes.git')).toBeNull()
      expect(remoteHost('C:\\notes.git')).toBeNull()
    })
  })
})
