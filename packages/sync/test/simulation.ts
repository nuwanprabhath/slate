// A three-device sync world for the simulation tests: random edits, offline switches and syncs from a seed, then
// sync rounds until nothing moves, and a check that every device holds the same documents.
import { expect, vi } from 'vitest'
import { PageDoc } from '@slate/core'
import * as coreIds from '../../core/src/ids'
import { SyncEngine } from '../src/engine'
import { OfflineError, type RemoteDrive } from '../src/types'
import { memoryDrive } from './memoryDrive'
import { addTextBox, appendText, editPage, memoryLocal, type MemoryLocal } from './memoryLocal'

export const PAGE = 'page:22222222-2222-4222-8222-222222222222'
export const NOTEBOOK = 'notebook:33333333-3333-4333-8333-333333333333'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** UUID-shaped ids from a seed: as scattered in id order as `newId`'s, and the same on every play. */
export function seededIds(seed: number): () => string {
  const rand = mulberry32(seed)
  const hex = (digits: number) => Array.from({ length: digits }, () => Math.floor(rand() * 16).toString(16)).join('')
  return () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`
}

/**
 * Runs `body` with every id @slate/core hands out drawn from `seed`: the boxes the simulation adds, and also the
 * copy the engine restores and its conflict records, which no parameter of the simulation could name. The actions
 * choose a box by its index in id order, so with `newId`'s own ids one plan edits a different box on each play
 * (FX-25). The swap is vitest's, around the module export: `newId` stays the one caller of Web Crypto, and
 * simulationReplay.test.ts fails if the swap ever stops reaching `PageDoc` or the engine.
 */
export async function withSeededIds<T>(seed: number, body: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(coreIds, 'newId').mockImplementation(seededIds(seed))
  try {
    return await body()
  } finally {
    spy.mockRestore()
  }
}

/** One device's connection to the shared drive, with its own offline switch. */
export function connection(shared: RemoteDrive): RemoteDrive & { offline: boolean } {
  const guard = <T>(run: () => Promise<T>) => (conn.offline ? Promise.reject(new OfflineError()) : run())
  const conn = {
    offline: false,
    upload: (path: string, bytes: Uint8Array) => guard(() => shared.upload(path, bytes)),
    download: (path: string) => guard(() => shared.download(path)),
    remove: (path: string) => guard(() => shared.remove(path)),
    delta: (cursor: string | null) => guard(() => shared.delta(cursor)),
    flush: () => guard(async () => shared.flush?.())
  }
  return conn
}

export interface Device {
  id: string
  local: MemoryLocal
  remote: ReturnType<typeof connection>
  engine: SyncEngine
}

/** Each device's own view of the shared remote. */
export type Drives = (deviceId: string) => RemoteDrive

export function sharedMemory(): Drives {
  const shared = memoryDrive()
  return () => shared
}

/** `seed` decides everything: the actions, and the ids, from a stream of their own so they do not shift the actions. */
export function simulate(seed: number, steps: number, drives: Drives = sharedMemory()): Promise<Device[]> {
  return withSeededIds(seed ^ 0x1d5eed, () => playSteps(seed, steps, drives))
}

async function playSteps(seed: number, steps: number, drives: Drives): Promise<Device[]> {
  const rand = mulberry32(seed)
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!
  let nextPeer = BigInt(seed) * 1000n + 1n
  const devices: Device[] = ['d1', 'd2', 'd3'].map((id) => {
    const local = memoryLocal()
    const remote = connection(drives(id))
    // A small threshold so compaction happens many times within a run.
    return { id, local, remote, engine: new SyncEngine({ local, remote, deviceId: id, deviceName: id, compactAfter: 4 }) }
  })

  for (let step = 0; step < steps; step++) {
    const d = pick(devices)
    const action = rand()
    if (action < 0.2) {
      const x = Math.floor(rand() * 800)
      editPage(d.local, PAGE, (p) => addTextBox(p, `b${step}`, { x, y: 0 }), nextPeer++)
    } else if (action < 0.5) {
      const ids = new PageDoc(d.local.doc(PAGE)).listBoxes().map((b) => b.id)
      if (ids.length > 0) {
        const id = pick(ids)
        editPage(d.local, PAGE, (p) => appendText(p, id, `${d.id}:${step} `), nextPeer++)
      }
    } else if (action < 0.6) {
      const ids = new PageDoc(d.local.doc(PAGE)).listBoxes().map((b) => b.id)
      if (ids.length > 0) {
        const id = pick(ids)
        const y = Math.floor(rand() * 2000)
        editPage(d.local, PAGE, (p) => p.updateBox(id, { y }), nextPeer++)
      }
    } else if (action < 0.62) {
      const ids = new PageDoc(d.local.doc(PAGE)).listBoxes().map((b) => b.id)
      if (ids.length > 1) {
        const id = pick(ids)
        editPage(d.local, PAGE, (p) => p.deleteBox(id), nextPeer++)
      }
    } else if (action < 0.65) {
      const name = `n${step}`
      editPage(d.local, NOTEBOOK, (p) => p.doc.getMap('pages').set(name, d.id), nextPeer++)
    } else if (action < 0.8) {
      d.remote.offline = !d.remote.offline
    } else {
      const report = await d.engine.syncOnce()
      expect(report.status).toBe(d.remote.offline ? 'offline' : 'idle-synced')
    }
  }

  for (const d of devices) d.remote.offline = false
  // Twice reaches everyone; a box restored on pulling a delete is a new local change, so rounds
  // continue until one pushes nothing. Restores cannot cascade: they delete nothing.
  for (let round = 0, pushed = 1; round < 2 || pushed > 0; round++) {
    expect(round).toBeLessThan(6)
    pushed = 0
    for (const d of devices) {
      const report = await d.engine.syncOnce()
      expect(report.status).toBe('idle-synced')
      pushed += report.pushed
    }
  }
  return devices
}

export function expectConverged([a, b, c]: Device[]): void {
  for (const docId of [PAGE, NOTEBOOK]) {
    const expected = a!.local.doc(docId).toJSON()
    expect(b!.local.doc(docId).toJSON()).toEqual(expected)
    expect(c!.local.doc(docId).toJSON()).toEqual(expected)
  }
  expect(new PageDoc(a!.local.doc(PAGE)).listBoxes().length).toBeGreaterThan(0)
}
