import { describe, expect, it, vi } from 'vitest'
import type { PqReadiness } from '../shared/api'
import { CH } from '../shared/ipc'
import type { Handler, IpcRegistrar } from './ipcGuard'
import { registerPqIpc } from './pqIpc'
import { pqVaultReadiness } from './vault/pqUpgrade'

vi.mock('./vault/pqUpgrade', () => ({ pqVaultReadiness: vi.fn(() => ({ kind: 'none' })) }))

const handlers = new Map<string, Handler>()
const ipc = { handle: (c: string, h: Handler) => void handlers.set(c, h), on: () => () => undefined } as unknown as IpcRegistrar
registerPqIpc(ipc)

describe('post-quantum IPC stubs', () => {
  it('T-PQ-Q0-01: vaultPqReadiness returns a PqReadiness and refuses arguments', async () => {
    const h = handlers.get(CH.vaultPqReadiness)!
    expect(await h({} as never)).toEqual({ atRest: 'symmetric-256', vault: { kind: 'none' }, transports: [], updateSignature: 'ml-dsa-65+ed25519', plaintextSync: false, requirePq: false })
    await expect(Promise.resolve().then(() => h({} as never, 'x'))).rejects.toThrow()
  })
  it('T-PQ-Q0-02: syncCheckTransport refuses any argument', async () => {
    const h = handlers.get(CH.syncCheckTransport)!
    expect(await h({} as never)).toEqual([])
    await expect(Promise.resolve().then(() => h({} as never, 1))).rejects.toThrow()
  })
  it('T-PQ-B3-04: the vault field is the upgrade state machine\'s, device names included (the log has the count only)', async () => {
    const vault: PqReadiness['vault'] = { kind: 'header', version: 2, upgrade: 'waiting-devices', waiting: { reason: 'devices', devices: ['Old laptop'] } }
    vi.mocked(pqVaultReadiness).mockReturnValueOnce(vault)
    expect(await handlers.get(CH.vaultPqReadiness)!({} as never)).toMatchObject({ vault })
    for (const waiting of [{ reason: 'sync-off' }, { reason: 'devices-unreadable' }] as const) {
      const reason: PqReadiness['vault'] = { kind: 'header', version: 2, upgrade: 'waiting-devices', waiting }
      vi.mocked(pqVaultReadiness).mockReturnValueOnce(reason)
      expect(await handlers.get(CH.vaultPqReadiness)!({} as never)).toMatchObject({ vault: reason })
    }
  })
})

describe('post-quantum IPC, transports (PQ-C4)', () => {
  const seen = [{ remote: 'git-ssh:github.com', transport: 'ssh' as const, kex: 'mlkem768x25519-sha256', pq: 'hybrid' as const, source: 'probe' as const, at: 1 }]
  const own = new Map<string, Handler>()
  let probes = 0
  registerPqIpc({ handle: (c: string, h: Handler) => void own.set(c, h), on: () => () => undefined } as unknown as IpcRegistrar, () => ({
    transports: () => seen,
    checkTransport: async () => {
      probes++
      return seen
    },
    requirePq: () => true,
    plaintextSync: () => true,
  }))

  it('T-PQ-C4-04: syncCheckTransport runs the probe in main and returns what it recorded', async () => {
    expect(await own.get(CH.syncCheckTransport)!({} as never)).toEqual(seen)
    expect(probes).toBe(1)
  })

  it('T-PQ-C4-04: vaultPqReadiness reports the recorded transports, requirePq and plaintextSync', async () => {
    expect(await own.get(CH.vaultPqReadiness)!({} as never)).toMatchObject({ transports: seen, requirePq: true, plaintextSync: true })
    expect(probes).toBe(1)
  })
})
