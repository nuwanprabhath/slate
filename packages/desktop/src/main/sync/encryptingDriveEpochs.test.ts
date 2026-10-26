// C9 (audit §4.7 R-2): after a rotation, files of an earlier key epoch stay readable through `history` (their names
// decode under that epoch's name keys, their envelopes open under its K_sync) until the rotating device has re-pushed
// everything and removed the old trees; nothing of an epoch the ring does not hold is ever returned.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SyncEngine, type RemoteDrive } from '@slate/sync'
import { VersionVector } from 'loro-crdt'
import { memoryDrive, type MemoryDrive } from '../../../../sync/test/memoryDrive'
import { PageDoc } from '@slate/core'
import { addTextBox, boxText, editPage, memoryLocal } from '../../../../sync/test/memoryLocal'
import { importKey } from '../../../test/vaultKeys'
import { parseEnvelope } from '../vault/envelope'
import { KeyRing } from '../vault/keyring'
import { vaultNative } from '../vault/native'
import { SCHEDULE_V1, scheduleV2, type KeySchedule } from '../vault/suite'
import { EncryptingDrive } from './encryptingDrive'

const VAULT = '7f8e9d0c-1b2a-4c3d-8e4f-5a6b7c8d9e0f'
const rings: KeyRing[] = []
afterEach(() => {
  for (const ring of rings.splice(0)) ring.close()
})

function ring(mk: Buffer, schedule: KeySchedule, history: Array<[number, Buffer, KeySchedule]> = []): KeyRing {
  const r = new KeyRing(importKey(mk, 'master'), undefined, schedule)
  r.attachHistory(new Map(history.map(([e, bytes, s]) => [e, { mk: importKey(bytes, 'master'), schedule: s }])))
  rings.push(r)
  return r
}

const files = (inner: MemoryDrive) => [...inner.files.keys()].sort()

function device(inner: RemoteDrive, keys: KeyRing) {
  const local = memoryLocal()
  const remote = new EncryptingDrive(inner, keys)
  const deviceId = randomUUID()
  return { local, remote, deviceId, engine: new SyncEngine({ local, remote, deviceId, deviceName: 'test' }) }
}

describe('EncryptingDrive across key epochs (C9)', () => {
  it('reads an epoch-0 file through history after a rotation, and writes only the current epoch', async () => {
    const inner = memoryDrive()
    const mk0 = randomBytes(32)
    const mk1 = randomBytes(32)
    const old = new EncryptingDrive(inner, ring(mk0, scheduleV2(VAULT, 'standard', 0)))
    const doc = randomUUID()
    const dev = randomUUID()
    await old.upload(`docs/page_${doc}/${dev}/00000001.chunk`, new Uint8Array([7, 7]))
    await old.upload(`devices/${dev}.json`, new Uint8Array([1]))
    const oldNames = files(inner)

    const now = new EncryptingDrive(inner, ring(mk1, scheduleV2(VAULT, 'standard', 1), [[0, mk0, scheduleV2(VAULT, 'standard', 0)]]))
    const listed = (await now.delta(null)).items.map((i) => i.path).sort()
    expect(listed).toEqual([`devices/${dev}.json`, `docs/page_${doc}/${dev}/00000001.chunk`].sort())
    expect(await now.download(`docs/page_${doc}/${dev}/00000001.chunk`)).toEqual(new Uint8Array([7, 7]))
    await now.upload(`devices/${dev}.json`, new Uint8Array([2]))
    const added = files(inner).filter((f) => !oldNames.includes(f))
    expect(added).toHaveLength(1)
    expect(parseEnvelope(inner.files.get(added[0]!)!)).toMatchObject({ format: 'SLE2', keyEpoch: 1 })
    // The current file wins over the old one for the same engine path.
    expect(await now.download(`devices/${dev}.json`)).toEqual(new Uint8Array([2]))
    expect(now.staleFiles()).toBe(2)

    // Without the history entry the old files are simply not ours: not listed, never opened.
    const blind = new EncryptingDrive(inner, ring(mk1, scheduleV2(VAULT, 'standard', 1)))
    expect((await blind.delta(null)).items.map((i) => i.path)).toEqual([`devices/${dev}.json`])
  })

  it('R-5: an upgraded vault reads its suite-0x01 files (epoch 0, SLE1, 32-hex names) through history', async () => {
    const inner = memoryDrive()
    const mk0 = randomBytes(32)
    const mk1 = randomBytes(32)
    const v1 = new EncryptingDrive(inner, ring(mk0, SCHEDULE_V1))
    const doc = randomUUID()
    const dev = randomUUID()
    await v1.upload(`docs/notebook_${doc}/${dev}/00000004.chunk`, new Uint8Array([4]))
    expect(files(inner)[0]).toMatch(/^e2ee\/d\/[0-9a-f]{32}\/[0-9a-f]{32}\/00000004\.c$/)
    const v2 = new EncryptingDrive(inner, ring(mk1, scheduleV2(VAULT, 'standard', 1), [[0, mk0, SCHEDULE_V1]]))
    expect((await v2.delta(null)).items.map((i) => i.path)).toEqual([`docs/notebook_${doc}/${dev}/00000004.chunk`])
    expect(await v2.download(`docs/notebook_${doc}/${dev}/00000004.chunk`)).toEqual(new Uint8Array([4]))
  })

  it('a device that missed the rotation pulls notes the rotating device re-pushed, and sweep removes the old trees', async () => {
    const inner = memoryDrive()
    const mk0 = randomBytes(32)
    const mk1 = randomBytes(32)
    // Before: B wrote a note under epoch 0.
    const b0 = device(inner, ring(mk0, scheduleV2(VAULT, 'standard', 0)))
    const page = `page:${randomUUID()}`
    const box = editPage(b0.local, page, (p) => addTextBox(p, 'written before the rotation'))
    expect((await b0.engine.syncOnce()).status).toBe('idle-synced')
    const blob = `${createHash('sha256').update(new Uint8Array([9])).digest('hex')}.png`
    await b0.remote.upload(`blobs/${blob}`, new Uint8Array([9]))
    const before = files(inner)

    // A rotated: it reads B's epoch-0 note through history, re-pushes under epoch 1, then sweeps the old trees.
    const a = device(inner, ring(mk1, scheduleV2(VAULT, 'standard', 1), [[0, mk0, scheduleV2(VAULT, 'standard', 0)]]))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(boxText(new PageDoc(a.local.doc(page)), box)).toBe('written before the rotation')
    expect(await a.remote.download(`blobs/${blob}`)).toEqual(new Uint8Array([9]))
    a.local.blobs.set(blob, new Uint8Array([9]))
    // Notes pulled from an old epoch are B's ops, which A's engine never pushes again; so the runner forgets what A
    // pushed and syncs once more before it sweeps (Migration.afterSync), until a sync reads nothing old.
    expect(a.remote.takeOldReads()).toBeGreaterThan(0)
    await a.local.setBytesMeta(`pushed:${page}`, new VersionVector(null).encode())
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(a.remote.takeOldReads()).toBe(0)
    expect(a.remote.staleFiles()).toBeGreaterThan(0)
    expect(await a.remote.sweep([blob], new Set())).toMatchObject({ kept: 0 })
    const after = files(inner)
    expect(after.filter((f) => before.includes(f))).toEqual([])
    for (const f of after) expect(parseEnvelope(inner.files.get(f)!)).toMatchObject({ keyEpoch: 1 })

    // A device on epoch 1 alone (B after adopting) reads everything.
    const b1 = device(inner, ring(mk1, scheduleV2(VAULT, 'standard', 1)))
    expect((await b1.engine.syncOnce()).status).toBe('idle-synced')
    expect(boxText(new PageDoc(b1.local.doc(page)), box)).toBe('written before the rotation')
    expect(await b1.remote.download(`blobs/${blob}`)).toEqual(new Uint8Array([9]))
    expect(b1.remote.staleFiles()).toBe(0)
  })
})

describe('review C9 M2: what a conversion may remove', () => {
  it('a ring without history keeps the files it cannot identify, and removes only those listed as superseded', async () => {
    const inner = memoryDrive()
    const mk0 = randomBytes(32)
    // B pushed a page under epoch 0 that the converting device never pulled.
    const b0 = device(inner, ring(mk0, scheduleV2(VAULT, 'standard', 0)))
    const page = `page:${randomUUID()}`
    editPage(b0.local, page, (p) => addTextBox(p, 'pushed by B, never pulled by A'))
    expect((await b0.engine.syncOnce()).status).toBe('idle-synced')
    const bFiles = files(inner)
    // A after the conversion: fips-140-3, epoch 1, an empty history.
    const a = device(inner, ring(randomBytes(32), scheduleV2(VAULT, 'fips-140-3', 1)))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(a.remote.takeOldReads()).toBe(0)
    // Nothing it can read as an earlier epoch's: nothing to prune for, and nothing removed on a guess.
    expect(a.remote.staleFiles()).toBe(0)
    expect(await a.remote.sweep([], new Set())).toEqual({ removed: 0, kept: bFiles.length })
    for (const f of bFiles) expect(inner.files.has(f)).toBe(true)
    // What it listed and pulled under the old keys before converting is positively superseded: removed.
    expect(await a.remote.sweep([], new Set(bFiles))).toEqual({ removed: bFiles.length, kept: 0 })
    for (const f of bFiles) expect(inner.files.has(f)).toBe(false)
  })
})

describe('KeyRing history (C9)', () => {
  it('owns the earlier epochs’ keys: derived on demand, destroyed with the ring (Z-4)', () => {
    const before = vaultNative().status().liveHandles
    const r = new KeyRing(importKey(randomBytes(32), 'master'), undefined, scheduleV2(VAULT, 'standard', 2))
    r.attachHistory(new Map([[1, { mk: importKey(randomBytes(32), 'master'), schedule: scheduleV2(VAULT, 'standard', 1) }]]))
    expect(r.historyEpochs).toEqual([1])
    expect(r.epochKeys(0)).toBeNull()
    const k = r.epochKeys(1)!
    expect(k.get('sync')).toBe(k.get('sync'))
    k.get('nameMac')
    expect(vaultNative().status().liveHandles).toBeGreaterThan(before)
    r.close()
    expect(vaultNative().status().liveHandles).toBe(before)
    expect(() => r.epochKeys(1)).toThrow(/locked/i)
  })
})
