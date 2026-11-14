// FX-37: sync's conflict code reads box content through core's data accessors and frees the fork it makes, so a
// document read and freed in one task, with no turn of the event loop, gives its memory back at once.
import * as loro from 'loro-crdt'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { PageDoc, type PMJSON } from '@slate/core'
import { boxesTouched, boxMarkdown } from '../src/conflicts'

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
