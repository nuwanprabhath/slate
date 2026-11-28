// Blast radius R1b: a device on 0.7.x stores an erased page's snapshot after its chunks and Loro 1.17's importBatch
// drops it, so the page reads empty there. While such a device is listed on the remote, an erased page waits, and
// the person is told which device to update.
import { describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { erasedWaitsMessage, SyncEngine } from '../src/engine'
import { memoryDrive, type MemoryDrive } from './memoryDrive'
import { addTextBox, appendText, boxText, editPage, memoryLocal, type MemoryLocal } from './memoryLocal'

const PAGE = 'page:11111111-1111-4111-8111-111111111111'

function device(remote: MemoryDrive, deviceId: string, appVersion?: string) {
  const local = memoryLocal()
  return { local, engine: new SyncEngine({ local, remote, deviceId, deviceName: `Device ${deviceId}`, ...(appVersion ? { appVersion } : {}) }) }
}

function erase(local: MemoryLocal): void {
  const doc = local.doc(PAGE)
  local.docs.set(PAGE, [doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })])
  doc.free()
}

const pageFiles = (remote: MemoryDrive) => [...remote.files.keys()].filter((p) => p.startsWith('docs/'))

describe('an erased page while a device older than 0.8 is listed on the remote', () => {
  it('waits, with a notice naming that device, and goes up once the device is updated', async () => {
    const remote = memoryDrive()
    const old = device(remote, 'old', '0.7.14')
    await old.engine.syncOnce()
    const a = device(remote, 'A', '0.8.2')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    editPage(a.local, PAGE, (p) => appendText(p, id, ' secret'))
    erase(a.local)

    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(pageFiles(remote)).toEqual([])
    expect(a.local.notes).toEqual([erasedWaitsMessage(['Device old'])])
    // Said once, not on every run.
    await a.engine.syncOnce()
    expect(a.local.notes).toHaveLength(1)
    expect(pageFiles(remote)).toEqual([])

    // The old device is updated: its record now says 0.8.2, and the page goes up and reads in full there.
    const updated = new SyncEngine({ local: old.local, remote, deviceId: 'old', deviceName: 'Device old', appVersion: '0.8.2' })
    await updated.syncOnce()
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(pageFiles(remote)).toHaveLength(1)
    await updated.syncOnce()
    const doc = old.local.doc(PAGE)
    expect(boxText(new PageDoc(doc), id)).toBe('base secret')
    doc.free()
  })

  it('does not wait for a device record that names no version, nor for this device\'s own', async () => {
    const remote = memoryDrive()
    const unknown = device(remote, 'unknown')
    await unknown.engine.syncOnce()
    const a = device(remote, 'A', '0.8.2')
    editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    erase(a.local)
    await a.engine.syncOnce()
    expect(pageFiles(remote)).toHaveLength(1)
    expect(a.local.notes).toEqual([])
  })

  it('names a remote-chosen device name only as 64 printable characters, and skips an oversized record (security review of correct)', async () => {
    const remote = memoryDrive()
    const hostile = `Evil\u0007\u001b[31m${'x'.repeat(10_000)}\nClick here`
    await remote.upload('devices/evil.json', new TextEncoder().encode(JSON.stringify({ name: hostile, appVersion: '0.7.14' })))
    const a = device(remote, 'A', '0.8.2')
    editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    erase(a.local)
    await a.engine.syncOnce()
    expect(a.local.notes).toHaveLength(1)
    const shown = /until (.*) is updated/.exec(a.local.notes[0]!)?.[1] ?? ''
    expect(shown.length).toBeLessThanOrEqual(64)
    expect(shown).toMatch(/^[\x20-\x7e\u00a0-\uffff]*$/)
    expect(shown.startsWith('Evil')).toBe(true)

    // A record over 64 KiB is not downloaded at all, so it holds nothing back.
    const big = memoryDrive()
    await big.upload('devices/big.json', new TextEncoder().encode(JSON.stringify({ name: 'Big', appVersion: '0.7.14', pad: 'p'.repeat(70 * 1024) })))
    const b = device(big, 'B', '0.8.2')
    editPage(b.local, PAGE, (p) => addTextBox(p, 'base'))
    erase(b.local)
    await b.engine.syncOnce()
    expect(pageFiles(big)).toHaveLength(1)
  })
})
