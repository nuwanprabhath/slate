import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devicesBlocking, devicesLacking, pqGateBlocking, PQ_CAPABILITY } from './deviceGate'
import { SYNCED_FILE } from './unlock'

const rec = (extra: Record<string, number> = {}, name = 'D') => ({ name, ...extra })

describe('deviceGate', () => {
  it('T-PQ-B2-02: a record without pq, with pq 0, or unreadable is listed; pq 1 and pq 2 are not', () => {
    expect(PQ_CAPABILITY).toBe(1)
    const none = rec({}, 'none')
    const zero = rec({ pq: 0 }, 'zero')
    const unreadable = { name: 'A device record Slate cannot read' }
    const one = rec({ pq: 1 }, 'one')
    const two = rec({ pq: 2 }, 'two')
    expect(devicesLacking([none, zero, unreadable, one, two], 'pq', 1)).toEqual([none, zero, unreadable])
  })

  it('T-PQ-B2-02: the epochs capability is checked the same way, and the level is respected', () => {
    const e1 = rec({ epochs: 1, pq: 1 }, 'e1')
    const e0 = rec({ pq: 1 }, 'e0')
    expect(devicesLacking([e1, e0], 'epochs', 1)).toEqual([e0])
    expect(devicesLacking([e1], 'pq', 2)).toEqual([e1])
  })

  it("the key-epoch gate still counts this device's own record: only the PQ gate leaves it out", () => {
    const own = { name: 'This Mac', own: true }
    expect(devicesBlocking([own])).toEqual([own])
  })

  it('T-PQ-B2-02: a record whose capability is not a number is listed', () => {
    const bad = { name: 'bad', pq: '1' as unknown as number }
    expect(devicesLacking([bad], 'pq', 1)).toEqual([bad])
  })

  describe('pqGateBlocking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-gate-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const remote = () => ({})

    it('names the devices that lack pq, as a structured reason', async () => {
      const devices = async () => [rec({ pq: 1 }, 'This Mac'), rec({}, 'nuwan-ubuntu'), rec({ pq: 0 }, 'Old laptop')]
      expect(await pqGateBlocking({ dataDir: dir, remote, devices })).toEqual({ reason: 'devices', devices: ['nuwan-ubuntu', 'Old laptop'] })
      expect(await pqGateBlocking({ dataDir: dir, remote, devices: async () => [rec({ pq: 1 })] })).toBeNull()
    })

    it("does not count this device's own record: a 0.3.0 record not yet rewritten by this build's first sync", async () => {
      const devices = async () => [{ name: 'This Mac', epochs: 1, own: true }, rec({ pq: 1 }, 'nuwan-ubuntu')]
      expect(await pqGateBlocking({ dataDir: dir, remote, devices })).toBeNull()
      // Another device without pq still blocks.
      const two = async () => [{ name: 'This Mac', own: true }, rec({}, 'nuwan-ubuntu')]
      expect(await pqGateBlocking({ dataDir: dir, remote, devices: two })).toEqual({ reason: 'devices', devices: ['nuwan-ubuntu'] })
    })

    it('says why when it cannot ask the devices: the list is unreadable, or sync is off on a vault that synced', async () => {
      expect(await pqGateBlocking({ dataDir: dir, remote })).toEqual({ reason: 'devices-unreadable' })
      expect(await pqGateBlocking({ dataDir: dir, remote, devices: () => Promise.reject(new Error('offline')) })).toEqual({ reason: 'devices-unreadable' })
      expect(await pqGateBlocking({ dataDir: dir, remote: () => null })).toBeNull()
      writeFileSync(join(dir, SYNCED_FILE), '{}')
      expect(await pqGateBlocking({ dataDir: dir, remote: () => null })).toEqual({ reason: 'sync-off' })
    })
  })
})
