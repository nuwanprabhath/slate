// FX-37: indexing a page reads box content through core's data accessor, so a page read and freed in one task, with
// no turn of the event loop, gives its memory back at once (the measurement style of core's handleLifetime test).
import * as loro from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { PageDoc, type PMJSON } from '@slate/core'
import { pageRows } from './searchIndex'

const heapBytes = (): number => (loro as unknown as { __wasm: { memory: { buffer: ArrayBuffer } } }).__wasm.memory.buffer.byteLength

const para = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const BOXES = 8
const PAGE_BYTES = ((): Uint8Array => {
  const page = new PageDoc()
  for (let b = 0; b < BOXES; b++) {
    page.addBox({ x: 0, y: b * 40, width: 300, content: [para(`box ${b} ${'lorem ipsum '.repeat(20)}`), { type: 'bulletList', content: [{ type: 'listItem', content: [para('nested')] }] }] })
  }
  return page.doc.export({ mode: 'snapshot' })
})()

/** Loro's heap grows 64 KiB at a time: one step across the 4,000 measured boxes reads 16 B a box, a leak kilobytes. */
const KEPT_BYTES = 1024
const SETTLE = 50
const MEASURED = 500

describe('indexing a page keeps nothing of it (FX-37)', () => {
  it('pageRows over every box keeps no Loro heap per box', () => {
    const op = () => {
      const page = PageDoc.fromUpdates([PAGE_BYTES])
      expect(pageRows(page)).toHaveLength(BOXES * 2)
      page.doc.free()
    }
    for (let i = 0; i < SETTLE; i++) op()
    const settled = heapBytes()
    for (let i = 0; i < MEASURED; i++) op()
    const kept = (heapBytes() - settled) / (MEASURED * BOXES)
    expect(kept, "bytes of Loro's heap kept per box").toBeLessThan(KEPT_BYTES)
  })
})
