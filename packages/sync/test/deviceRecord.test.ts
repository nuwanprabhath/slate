import { describe, expect, it } from 'vitest'
import { SyncEngine } from '../src/engine'
import { memoryDrive } from './memoryDrive'
import { memoryLocal } from './memoryLocal'

const DEVICE = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'

/** GDPR-03: the device record names the device only by what the caller passes; the engine adds nothing of its own. */
describe('the device record', () => {
  it('carries exactly the capabilities, the given name, platform and app version, plus lastSeen', async () => {
    const remote = memoryDrive()
    const engine = new SyncEngine({
      local: memoryLocal(),
      remote,
      deviceId: DEVICE,
      deviceName: 'Device 0f1e2d3c',
      platform: 'darwin',
      appVersion: '9.9.9',
      capabilities: { epochs: 1, pq: 1 },
    })
    expect((await engine.syncOnce()).status).toBe('idle-synced')
    const record = JSON.parse(new TextDecoder().decode(remote.files.get(`devices/${DEVICE}.json`))) as Record<string, unknown>
    const { lastSeen, ...rest } = record
    expect(typeof lastSeen).toBe('number')
    expect(rest).toEqual({ epochs: 1, pq: 1, name: 'Device 0f1e2d3c', platform: 'darwin', appVersion: '9.9.9' })
  })

  it('lets no capability override the name the caller chose', async () => {
    const remote = memoryDrive()
    const engine = new SyncEngine({ local: memoryLocal(), remote, deviceId: DEVICE, deviceName: 'Device 0f1e2d3c', capabilities: { name: 7 } })
    await engine.syncOnce()
    const record = JSON.parse(new TextDecoder().decode(remote.files.get(`devices/${DEVICE}.json`))) as Record<string, unknown>
    expect(record.name).toBe('Device 0f1e2d3c')
  })
})
