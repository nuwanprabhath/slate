import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as loro from 'loro-crdt'
import { search } from '@slate/mcp'
import { NotebookDoc, PageDoc } from '@slate/core'
import { DocStore } from '../store'
import { storeDocSource } from './docSource'

const loroHeapBytes = (): number => (loro as unknown as { __wasm: { memory: { buffer: ArrayBuffer } } }).__wasm.memory.buffer.byteLength

const PAGES = 1200
/**
 * Measured before the fix: +111 kB of Loro heap per page read in one task, which a search repeats on
 * every call. 16 KiB is seven times under that, and neither figure is a time.
 */
const KEPT_BYTES_PER_PAGE = 16 * 1024

describe('search gives back the pages it decodes (FX-33)', () => {
  it("a search over many shared pages leaves Loro's heap where it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-fx33-'))
    const store = new DocStore(join(dir, 'slate.db'))
    const source = storeDocSource(() => store)
    try {
      const nb = NotebookDoc.create('Notebook')
      const section = nb.addSection('Open')
      nb.setAccess(section, 'read')
      for (let i = 0; i < PAGES; i++) {
        const { pageId } = nb.addPage(section, `Page ${i}`)
        const page = new PageDoc()
        for (let b = 0; b < 8; b++) page.addBox({ x: 0, y: b * 40, width: 300, content: [{ type: 'paragraph', content: [{ type: 'text', text: `page ${i} box ${b} ${'lorem ipsum '.repeat(30)}` }] }] })
        store.append(`page:${pageId}`, page.doc.export({ mode: 'snapshot' }))
        page.doc.free()
      }
      store.append('notebook:nb', nb.doc.export({ mode: 'snapshot' }))
      nb.doc.free()

      expect(await search(source, 'page 7 box 3')).toHaveLength(1)
      const settled = loroHeapBytes()
      expect(await search(source, 'page 11 box 3')).toHaveLength(1)
      expect(await search(source, 'page 13 box 3')).toHaveLength(1)
      expect((loroHeapBytes() - settled) / (2 * PAGES), 'bytes of Loro heap a page read kept').toBeLessThan(KEPT_BYTES_PER_PAGE)
    } finally {
      source.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10 * 60_000)
})
