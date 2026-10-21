import { describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { SyncEngine } from '../src/engine'
import { parseRemotePath } from '../src/paths'
import { memoryDrive, type MemoryDrive } from './memoryDrive'
import { addTextBox, appendText, boxText, editPage, memoryLocal, type MemoryLocal } from './memoryLocal'

const PAGE = 'page:11111111-1111-4111-8111-111111111111'

function device(remote: MemoryDrive, deviceId: string, compactAfter?: number) {
  const local = memoryLocal()
  const engine = new SyncEngine({ local, remote, deviceId, deviceName: deviceId, compactAfter })
  return { local, engine }
}

const filesOf = (remote: MemoryDrive, deviceId: string, kind: 'chunk' | 'snapshot') =>
  [...remote.files.keys()].filter((p) => {
    const parsed = parseRemotePath(p)
    return parsed.kind === kind && parsed.deviceId === deviceId
  })

const json = (local: MemoryLocal, docId = PAGE) => local.doc(docId).toJSON()

describe('SyncEngine', () => {
  it('carries a box added on A to B', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'hello'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    const report = await b.engine.syncOnce()
    expect(report).toMatchObject({ status: 'idle-synced', pulled: 1 })
    expect(boxText(new PageDoc(b.local.doc(PAGE)), id)).toBe('hello')
  })

  it('converges concurrent edits to different boxes', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    const [x, y] = editPage(a.local, PAGE, (p) => [addTextBox(p, 'x'), addTextBox(p, 'y', { x: 0, y: 300 })])
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, x!, ' from A'))
    editPage(b.local, PAGE, (p) => appendText(p, y!, ' from B'))
    for (let i = 0; i < 2; i++) {
      await a.engine.syncOnce()
      await b.engine.syncOnce()
    }
    expect(json(a.local)).toEqual(json(b.local))
    const page = new PageDoc(a.local.doc(PAGE))
    expect([boxText(page, x!), boxText(page, y!)]).toEqual(['x from A', 'y from B'])
  })

  it('uploads nothing when nothing is unpushed', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    editPage(a.local, PAGE, (p) => addTextBox(p, 'once'))
    expect((await a.engine.syncOnce()).pushed).toBe(1)
    const files = filesOf(remote, 'A', 'chunk').length
    expect((await a.engine.syncOnce()).pushed).toBe(0)
    expect(filesOf(remote, 'A', 'chunk')).toHaveLength(files)
  })

  it('never re-uploads a remote op', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    editPage(a.local, PAGE, (p) => addTextBox(p, 'from A'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    await b.engine.syncOnce()
    expect(filesOf(remote, 'B', 'chunk')).toHaveLength(0)
  })

  it('does not re-upload remote ops pulled while local edits were unpushed', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    const x = editPage(a.local, PAGE, (p) => addTextBox(p, 'big text from A'.repeat(50)))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, x, ' more from A'.repeat(50)))
    await a.engine.syncOnce()
    // The user types on B while B's sync is between its push and its pull.
    const delta = remote.delta.bind(remote)
    remote.delta = async (cursor) => {
      editPage(b.local, PAGE, (p) => addTextBox(p, 'B', { x: 0, y: 400 }))
      remote.delta = delta
      return delta(cursor)
    }
    await b.engine.syncOnce()
    await b.engine.syncOnce()
    const bChunks = filesOf(remote, 'B', 'chunk').map((p) => remote.files.get(p)!.length)
    expect(bChunks).toHaveLength(1)
    expect(bChunks[0]).toBeLessThan(400)
    await a.engine.syncOnce()
    expect(json(a.local)).toEqual(json(b.local))
  })

  it('compacts past the threshold into a snapshot a fresh device can start from', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, ''))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    for (let i = 0; i < 51; i++) {
      editPage(a.local, PAGE, (p) => appendText(p, id, String(i % 10)))
      await a.engine.syncOnce()
    }
    expect(filesOf(remote, 'A', 'snapshot')).toHaveLength(1)
    expect(filesOf(remote, 'A', 'chunk').length).toBeLessThanOrEqual(1)
    await b.engine.syncOnce()
    const c = device(remote, 'C')
    await c.engine.syncOnce()
    expect(json(c.local)).toEqual(json(a.local))
    expect(json(b.local)).toEqual(json(a.local))
    expect(boxText(new PageDoc(c.local.doc(PAGE)), id)).toHaveLength(51)
  })

  it('uploads each blob once', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    a.local.blobs.set('abc.png', new Uint8Array([1, 2, 3]))
    await a.engine.syncOnce()
    expect(remote.files.get('blobs/abc.png')).toEqual(new Uint8Array([1, 2, 3]))
    remote.files.delete('blobs/abc.png')
    await a.engine.syncOnce()
    expect(remote.files.has('blobs/abc.png')).toBe(false)
  })

  it('writes its device record', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    await a.engine.syncOnce()
    const record = JSON.parse(new TextDecoder().decode(remote.files.get('devices/A.json')))
    expect(record).toMatchObject({ name: 'A' })
    expect(typeof record.lastSeen).toBe('number')
  })

  it('reports offline without throwing and catches up once online', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    editPage(a.local, PAGE, (p) => addTextBox(p, 'queued'))
    remote.offline = true
    expect(await a.engine.syncOnce()).toMatchObject({ status: 'offline', pushed: 0 })
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'offline' })
    remote.offline = false
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect((await b.engine.syncOnce()).status).toBe('idle-synced')
    expect(json(b.local)).toEqual(json(a.local))
  })

  it('maps a 401 to signed-out and other failures to error', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    remote.delta = async () => {
      throw Object.assign(new Error('Graph 401'), { status: 401 })
    }
    expect((await a.engine.syncOnce()).status).toBe('signed-out')
    remote.delta = async () => {
      throw new Error('Graph 500')
    }
    expect(await a.engine.syncOnce()).toMatchObject({ status: 'error', message: 'Graph 500' })
  })

  it('flushes a drive that batches writes after the push and at the end', async () => {
    const remote = memoryDrive()
    const calls: string[] = []
    const batching = {
      upload: async (path: string, bytes: Uint8Array) => (calls.push('upload'), remote.upload(path, bytes)),
      download: (path: string) => remote.download(path),
      remove: (path: string) => remote.remove(path),
      delta: async (cursor: string | null) => (calls.push('delta'), remote.delta(cursor)),
      flush: async () => void calls.push('flush')
    }
    const local = memoryLocal()
    const engine = new SyncEngine({ local, remote: batching, deviceId: 'A', deviceName: 'A' })
    editPage(local, PAGE, (p) => addTextBox(p, 'batched'))
    expect((await engine.syncOnce()).status).toBe('idle-synced')
    expect(calls.filter((c) => c !== 'upload')).toEqual(['flush', 'delta', 'flush'])
  })

  it('reports a failed flush like any drive failure', async () => {
    const remote = memoryDrive()
    const local = memoryLocal()
    const drive = { ...remote, flush: () => Promise.reject(Object.assign(new Error('denied'), { status: 401 })) }
    const engine = new SyncEngine({ local, remote: drive, deviceId: 'A', deviceName: 'A' })
    editPage(local, PAGE, (p) => addTextBox(p, 'x'))
    expect(await engine.syncOnce()).toMatchObject({ status: 'signed-out' })
  })
})
