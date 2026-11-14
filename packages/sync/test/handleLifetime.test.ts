// FX-37: sync's conflict code reads box content through core's data accessors and frees the fork it makes, so a
// document read and freed in one task, with no turn of the event loop, gives its memory back at once.
import * as loro from 'loro-crdt'
import { LoroCounter, LoroDoc, LoroList, LoroMap, LoroMovableList, LoroText, LoroTree, LoroTreeNode } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { PageDoc, type PMJSON } from '@slate/core'
import { boxesTouched, boxMarkdown } from '../src/conflicts'
import { SyncEngine } from '../src/engine'
import { memoryDrive } from './memoryDrive'
import { addTextBox, appendText, editPage, memoryLocal } from './memoryLocal'

type HandleClass = { name: string; __wrap(ptr: number): object; prototype: { free(): void } }
/** Every class Loro hands out that keeps its document alive; a `LoroDoc` it hands out is a fork. */
const HANDLE_CLASSES = [LoroMap, LoroList, LoroMovableList, LoroText, LoroTree, LoroTreeNode, LoroCounter, LoroDoc] as unknown as HandleClass[]
/** Handles Loro returned that nobody has freed, by class. `__wrap` is where wasm-bindgen makes every returned object. */
const live = new Map<object, string>()
for (const cls of HANDLE_CLASSES) {
  const wrap = cls.__wrap
  cls.__wrap = (ptr) => {
    const handle = wrap.call(cls, ptr)
    live.set(handle, cls.name)
    return handle
  }
  const free = cls.prototype.free
  cls.prototype.free = function (this: object) {
    live.delete(this)
    free.call(this)
  }
}
const liveClasses = (): string[] => [...live.values()].sort()

const heapBytes = (): number => (loro as unknown as { __wasm: { memory: { buffer: ArrayBuffer } } }).__wasm.memory.buffer.byteLength

const para = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const BOXES = 8
const PAGE = ((): { bytes: Uint8Array; ids: string[] } => {
  const page = new PageDoc()
  for (let b = 0; b < BOXES; b++) page.addBox({ x: 0, y: b * 40, width: 300, content: [para(`box ${b} ${'lorem ipsum '.repeat(20)}`)] })
  return { bytes: page.doc.export({ mode: 'snapshot' }), ids: page.stackOrder() }
})()

/** Loro's heap grows 64 KiB at a time: one step across the 4,000 measured boxes reads 16 B a box, a leak kilobytes. */
const KEPT_BYTES = 1024
const SETTLE = 50
const MEASURED = 500

function keptPerBox(op: () => void): number {
  for (let i = 0; i < SETTLE; i++) op()
  const settled = heapBytes()
  for (let i = 0; i < MEASURED; i++) op()
  return (heapBytes() - settled) / (MEASURED * BOXES)
}

describe('conflict detection keeps nothing of a document it read (FX-37)', () => {
  it('boxMarkdown over every box of a page keeps no Loro heap per box', () => {
    const kept = keptPerBox(() => {
      const doc = new LoroDoc()
      doc.import(PAGE.bytes)
      for (const id of PAGE.ids) expect(boxMarkdown(doc, id)).toContain('lorem')
      doc.free()
    })
    expect(kept, "bytes of Loro's heap kept per box").toBeLessThan(KEPT_BYTES)
  })

  it('boxesTouched frees the fork it imports into', () => {
    const base = new LoroDoc()
    base.import(PAGE.bytes)
    const edited = PageDoc.fromUpdates([PAGE.bytes])
    edited.deleteBox(PAGE.ids[0]!)
    const update = edited.doc.export({ mode: 'update', from: base.oplogVersion() })
    const realFork = LoroDoc.prototype.fork
    const frees: Array<ReturnType<typeof vi.fn>> = []
    const fork = vi.spyOn(LoroDoc.prototype, 'fork').mockImplementation(function (this: LoroDoc) {
      const made = realFork.call(this)
      const realFree = made.free.bind(made)
      const free = vi.fn(() => realFree())
      made.free = free
      frees.push(free)
      return made
    })
    try {
      expect([...boxesTouched(base, update).deleted]).toEqual([PAGE.ids[0]])
      expect(frees).toHaveLength(1)
      expect(frees[0], 'the fork is freed').toHaveBeenCalledTimes(1)
    } finally {
      fork.mockRestore()
    }
  })
})

// FX-38: what the lint rule slate/loro-handles-through-scope found in sync. A Loro event's diff carries a handle
// for every container the update put under a key, and the engine kept a fork of each pulled doc for the whole pull.
describe('sync reads Loro through a handle scope (FX-38)', () => {
  it('boxesTouched leaves no handle alive: not its fork, not the containers its events carry', () => {
    const base = new LoroDoc()
    base.import(PAGE.bytes)
    const edited = PageDoc.fromUpdates([PAGE.bytes])
    edited.deleteBox(PAGE.ids[0]!)
    const added = edited.addBox({ x: 0, y: 900, width: 300, content: [para('a new box')] })
    edited.updateBox(PAGE.ids[1]!, { x: 40 })
    const update = edited.doc.export({ mode: 'update', from: base.oplogVersion() })
    live.clear()
    const touched = boxesTouched(base, update)
    expect(liveClasses()).toEqual([])
    expect([...touched.deleted]).toEqual([PAGE.ids[0]])
    expect([...touched.contentEdited]).toEqual([added])
  })

  it('a pull that records a conflict leaves no fork alive, and still tells mine from theirs', async () => {
    const page = 'page:55555555-5555-4555-8555-555555555555'
    const remote = memoryDrive()
    const device = (deviceId: string) => {
      const local = memoryLocal()
      return { local, engine: new SyncEngine({ local, remote, deviceId, deviceName: deviceId }) }
    }
    const a = device('A')
    const b = device('B')
    const x = editPage(a.local, page, (p) => addTextBox(p, 'base'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    remote.offline = true
    editPage(a.local, page, (p) => appendText(p, x, ' alpha'))
    editPage(b.local, page, (p) => appendText(p, x, ' beta'))
    remote.offline = false
    await a.engine.syncOnce()
    live.clear()
    expect(await b.engine.syncOnce()).toMatchObject({ conflicts: 1 })
    expect(liveClasses()).toEqual([])
    expect(b.local.conflicts[0]).toMatchObject({ boxId: x, mine: 'base beta', theirs: 'base alpha' })
  })
})
