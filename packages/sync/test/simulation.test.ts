import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { SyncEngine } from '../src/engine'
import { GitDrive } from '../src/gitDrive'
import { nodeGitRunner } from '../src/gitRunner'
import { OfflineError, type RemoteDrive } from '../src/types'
import { memoryDrive } from './memoryDrive'
import { addTextBox, appendText, editPage, memoryLocal, type MemoryLocal } from './memoryLocal'

const PAGE = 'page:22222222-2222-4222-8222-222222222222'
const NOTEBOOK = 'notebook:33333333-3333-4333-8333-333333333333'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One device's connection to the shared drive, with its own offline switch. */
function connection(shared: RemoteDrive): RemoteDrive & { offline: boolean } {
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

interface Device {
  id: string
  local: MemoryLocal
  remote: ReturnType<typeof connection>
  engine: SyncEngine
}

/** Each device's own view of the shared remote. */
type Drives = (deviceId: string) => RemoteDrive

function sharedMemory(): Drives {
  const shared = memoryDrive()
  return () => shared
}

async function simulate(seed: number, steps: number, drives: Drives = sharedMemory()): Promise<Device[]> {
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

function expectConverged([a, b, c]: Device[]): void {
  for (const docId of [PAGE, NOTEBOOK]) {
    const expected = a!.local.doc(docId).toJSON()
    expect(b!.local.doc(docId).toJSON()).toEqual(expected)
    expect(c!.local.doc(docId).toJSON()).toEqual(expected)
  }
  expect(new PageDoc(a!.local.doc(PAGE)).listBoxes().length).toBeGreaterThan(0)
}

describe('three-device simulation', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`converges for seed ${seed}`, async () => {
      expectConverged(await simulate(seed, 200))
    })
  }

  it('converges over git clones of one bare repo', { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'slate-sim-'))
    try {
      const bare = join(root, 'remote.git')
      execFileSync('git', ['init', '--bare', '--initial-branch=main', bare])
      const run = nodeGitRunner()
      const drives: Drives = (id) =>
        new GitDrive({ run, dir: join(root, id), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}), author: { name: id, email: `${id}@test.local` } })
      expectConverged(await simulate(1, 200, drives))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
