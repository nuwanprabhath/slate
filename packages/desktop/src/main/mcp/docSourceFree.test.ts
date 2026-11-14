import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookDoc, PageDoc } from '@slate/core'
import { DocStore } from '../store'
import { storeDocSource } from './docSource'

/**
 * FX-32: a Loro doc lives in WebAssembly memory the garbage collector never reclaims, so every page doc
 * the source stops using must be freed, exactly once.
 */
const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0).reverse()) c()
})

function newStore(): DocStore {
  const dir = mkdtempSync(join(tmpdir(), 'slate-fx32-'))
  const store = new DocStore(join(dir, 'slate.db'))
  cleanups.push(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

function seedPages(store: DocStore, n: number): string[] {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const page = new PageDoc()
    page.addBox({ x: 0, y: 0, width: 100, content: [{ type: 'paragraph', content: [{ type: 'text', text: `p${i}` }] }] })
    store.append(`page:p${i}`, page.doc.export({ mode: 'snapshot' }))
    page.doc.free()
    ids.push(`p${i}`)
  }
  return ids
}

/** Every page doc the source decodes, with how many times each was freed. */
function trackPages(): Array<{ doc: PageDoc; frees: number }> {
  const made: Array<{ doc: PageDoc; frees: number }> = []
  const real = PageDoc.fromUpdates.bind(PageDoc)
  vi.spyOn(PageDoc, 'fromUpdates').mockImplementation((parts) => {
    const doc = real(parts)
    const entry = { doc, frees: 0 }
    const free = doc.doc.free.bind(doc.doc)
    doc.doc.free = () => {
      entry.frees++
      free()
    }
    made.push(entry)
    return doc
  })
  return made
}

describe('storeDocSource frees what it stops using (FX-32)', () => {
  it('frees each page doc it evicts past the cache, and only those', async () => {
    const store = newStore()
    const ids = seedPages(store, 70)
    const made = trackPages()
    const source = storeDocSource(() => store)
    for (const id of ids) await source.readPage(id)
    expect(made).toHaveLength(70)
    expect(made.slice(0, 6).map((m) => m.frees)).toEqual([1, 1, 1, 1, 1, 1])
    expect(made.slice(6).every((m) => m.frees === 0)).toBe(true)
    // The survivors still read: nothing in use was freed.
    expect((await source.readPage('p69')).boxes).toHaveLength(1)
  })

  it('frees the replaced doc when a compaction forces a full reload', async () => {
    const store = newStore()
    seedPages(store, 1)
    const made = trackPages()
    const source = storeDocSource(() => store)
    await source.appendBox('p0', [{ type: 'paragraph' }])
    store.compact('page:p0')
    expect((await source.readPage('p0')).boxes).toHaveLength(2)
    expect(made).toHaveLength(2)
    expect(made.map((m) => m.frees)).toEqual([1, 0])
  })

  it('frees every cached doc when the store changes and when the source closes', async () => {
    let store = newStore()
    seedPages(store, 3)
    const made = trackPages()
    const source = storeDocSource(() => store)
    for (const id of ['p0', 'p1', 'p2']) await source.readPage(id)
    store = newStore()
    seedPages(store, 2)
    await source.readPage('p0')
    expect(made.map((m) => m.frees)).toEqual([1, 1, 1, 0])
    await source.readPage('p1')
    source.close()
    expect(made.map((m) => m.frees)).toEqual([1, 1, 1, 1, 1])
  })

  it('frees the page doc createPage builds once it is saved', async () => {
    const store = newStore()
    const probe = new PageDoc()
    const loroProto = Object.getPrototypeOf(probe.doc) as { free(): void }
    probe.doc.free()
    const source = storeDocSource(() => store)
    const free = vi.spyOn(loroProto, 'free')
    await source.createPage('n1', [{ type: 'paragraph' }])
    expect(free).toHaveBeenCalledTimes(1)
    free.mockRestore()
    expect((await source.readPage('n1')).boxes).toHaveLength(1)
  })

  it('frees cached notebook docs on close', async () => {
    const store = newStore()
    const nb = NotebookDoc.create('Work')
    store.append('notebook:nb1', nb.doc.export({ mode: 'snapshot' }))
    nb.doc.free()
    const source = storeDocSource(() => store)
    const [ref] = await source.notebooks()
    const free = vi.spyOn(ref!.doc.doc, 'free')
    source.close()
    expect(free).toHaveBeenCalledTimes(1)
  })
})
