import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshKexProbe } from '@slate/sync'
import type { TransportObservation, VaultState } from '../../shared/api'
import { HYBRID_TLS_GROUP } from '../tlsPolicy'
import { ONEDRIVE_HOSTS, probeTransports, tlsGroup, type ProbeInput } from './transportProbe'

// The test-only self-signed certificate of T-PQ-C3 (fixtures/tls/README.md).
const cert = readFileSync(join(__dirname, '../fixtures/tls/cert.pem'))
const key = readFileSync(join(__dirname, '../fixtures/tls/key.pem'))

interface Loopback {
  port: number
  /** Application bytes the server received after its handshakes. */
  received: () => number
  close: () => Promise<void>
}

async function loopback(group: string): Promise<Loopback> {
  let received = 0
  const server = tls.createServer({ cert, key, ecdhCurve: group }, (socket) => {
    socket.on('data', (b: Buffer) => (received += b.length))
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    received: () => received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const servers: Loopback[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

const noHybridSsh: SshKexProbe = { hybrid: [], ssh: null, prepend: false }

function input(overrides: Partial<ProbeInput>): ProbeInput & { recorded: TransportObservation[] } {
  const recorded: TransportObservation[] = []
  return {
    state: 'unlocked',
    settings: { syncProvider: null, syncRequirePq: false },
    graphUrl: 'https://graph.microsoft.com/v1.0',
    git: async () => ({ ok: true, message: 'Connected.' }),
    ssh: async () => noHybridSsh,
    tls: async () => null,
    record: (o) => recorded.push(o),
    now: () => 1_000,
    ...overrides,
    recorded,
  }
}

describe('transport probe (PQ-C4)', () => {
  it('T-PQ-C4-04: OneDrive hosts behind a hybrid and a classical loopback server record hybrid and classical, with zero application bytes sent', async () => {
    const hybrid = await loopback(HYBRID_TLS_GROUP)
    const classical = await loopback('secp384r1')
    servers.push(hybrid, classical)
    const [graph, login] = ONEDRIVE_HOSTS
    const portFor: Record<string, number> = { [graph]: hybrid.port, [login]: classical.port }
    const probe = input({
      settings: { syncProvider: 'onedrive', syncRequirePq: false },
      tls: (host) => tlsGroup('127.0.0.1', portFor[host]!, { ca: cert, servername: 'localhost' }),
    })
    const seen = await probeTransports(probe)
    expect(seen).toEqual([
      { remote: `onedrive:${graph}`, transport: 'tls', kex: HYBRID_TLS_GROUP, pq: 'hybrid', source: 'probe', at: 1_000 },
      { remote: `onedrive:${login}`, transport: 'tls', kex: 'secp384r1', pq: 'classical', source: 'probe', at: 1_000 },
    ])
    expect(probe.recorded).toEqual(seen)
    // Let a close_notify or stray write arrive before counting.
    await new Promise((r) => setTimeout(r, 50))
    expect(hybrid.received() + classical.received()).toBe(0)
  })

  it('T-PQ-C4-04: a git ssh remote records what testConnection saw, with the prefer command', async () => {
    const commands: Array<string | undefined> = []
    const probe = input({
      settings: { syncProvider: 'git', git: { remoteUrl: 'git@github.com:me/notes.git', branch: 'main', auth: 'system' }, syncRequirePq: false },
      ssh: async () => ({ hybrid: ['mlkem768x25519-sha256'], ssh: 'OpenSSH_10.0', prepend: true }),
      git: async (_url, sshCommand) => {
        commands.push(sshCommand)
        return { ok: true, message: 'Connected.', kex: 'mlkem768x25519-sha256', pq: 'hybrid', remote: 'git-ssh:github.com' }
      },
    })
    expect(await probeTransports(probe)).toEqual([{ remote: 'git-ssh:github.com', transport: 'ssh', kex: 'mlkem768x25519-sha256', pq: 'hybrid', source: 'probe', at: 1_000 }])
    expect(commands).toEqual(['ssh -o BatchMode=yes -o KexAlgorithms=^mlkem768x25519-sha256'])
  })

  it('T-PQ-C4-04: OneDrive against a test drive (not https) and a local git remote probe nothing', async () => {
    let calls = 0
    const count = async () => {
      calls++
      return null
    }
    expect(await probeTransports(input({ settings: { syncProvider: 'onedrive', syncRequirePq: false }, graphUrl: 'http://127.0.0.1:9/v1.0', tls: count }))).toEqual([])
    const git = async () => {
      calls++
      return { ok: true, message: '' }
    }
    expect(await probeTransports(input({ settings: { syncProvider: 'git', git: { remoteUrl: 'file:///tmp/r.git', branch: 'main', auth: 'system' }, syncRequirePq: false }, git }))).toEqual([])
    expect(calls).toBe(0)
  })

  it('T-PQ-C4-04: with syncRequirePq an https git remote is not contacted', async () => {
    let calls = 0
    const probe = input({
      settings: { syncProvider: 'git', git: { remoteUrl: 'https://github.com/me/notes.git', branch: 'main', auth: 'system' }, syncRequirePq: true },
      git: async () => {
        calls++
        return { ok: true, message: '' }
      },
    })
    expect(await probeTransports(probe)).toEqual([])
    expect(calls).toBe(0)
  })

  it.each<VaultState>(['locked', 'unlocking', 'locking', 'migrating', 'selftest', 'selftest-failed'])(
    'T-PQ-C4-05: the probe refuses to run while the vault is %s',
    async (state) => {
      let calls = 0
      const counted = async () => {
        calls++
        return null
      }
      const probe = input({ state, settings: { syncProvider: 'onedrive', syncRequirePq: false }, tls: counted, ssh: async () => (calls++, noHybridSsh) })
      await expect(probeTransports(probe)).rejects.toThrow(/notes are open/)
      expect(calls).toBe(0)
      expect(probe.recorded).toEqual([])
    },
  )

  it.each<VaultState>(['unlocked', 'plaintext'])('T-PQ-C4-05: the probe runs while the vault is %s', async (state) => {
    let calls = 0
    const probe = input({
      state,
      settings: { syncProvider: 'onedrive', syncRequirePq: false },
      tls: async () => {
        calls++
        return 'X25519'
      },
    })
    expect(await probeTransports(probe)).toHaveLength(ONEDRIVE_HOSTS.length)
    expect(calls).toBe(ONEDRIVE_HOSTS.length)
  })
})
