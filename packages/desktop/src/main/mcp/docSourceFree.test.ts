import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookDoc, PageDoc } from '@slate/core'
import * as loro from 'loro-crdt'
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

function seedNotebooks(store: DocStore, n: number): void {
  for (let i = 0; i < n; i++) {
    const nb = NotebookDoc.create(`nb${i}`)
    nb.addSection('Ops')
    store.append(`notebook:nb${i}`, nb.doc.export({ mode: 'snapshot' }))
    nb.doc.free()
  }
}

/** Every notebook doc the source decodes, with how many times each was freed. */
function trackNotebooks(): Array<{ doc: NotebookDoc; frees: number }> {
  const made: Array<{ doc: NotebookDoc; frees: number }> = []
  const real = NotebookDoc.fromUpdates.bind(NotebookDoc)
  vi.spyOn(NotebookDoc, 'fromUpdates').mockImplementation((parts) => {
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

const loroHeapBytes = (): number => (loro as unknown as { __wasm: { memory: { buffer: ArrayBuffer } } }).__wasm.memory.buffer.byteLength

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
    seedNotebooks(store, 1)
    const made = trackNotebooks()
    const source = storeDocSource(() => store)
    expect(await source.notebooks()).toHaveLength(1)
    source.close()
    expect(made.map((m) => m.frees)).toEqual([1])
  })
})

describe('storeDocSource lends notebook docs for a borrow and frees them after (FX-34)', () => {
  it('a notebook evicted while it is borrowed stays usable until the borrow ends, then is freed once', async () => {
    const store = newStore()
    seedNotebooks(store, 40)
    const made = trackNotebooks()
    const source = storeDocSource(() => store)
    const name = await source.withNotebook('nb0', async (doc) => {
      // Listing 40 notebooks pushes nb0 out of the 32-entry cache inside this borrow.
      expect(await source.notebooks()).toHaveLength(40)
      expect(made[0]!.frees).toBe(0)
      // A freed doc would throw `RuntimeError: unreachable` here and poison the WebAssembly instance.
      doc.addSection('Still mine')
      return doc.name
    })
    expect(name).toBe('nb0')
    expect(made[0]!.frees).toBe(1)
    expect(made.filter((m) => m.frees > 1)).toEqual([])
    expect(await source.withNotebook('missing', async () => 'ran')).toBeNull()
  })

  it('frees each notebook doc it evicts past the cache, and only those', async () => {
    const store = newStore()
    seedNotebooks(store, 40)
    const made = trackNotebooks()
    const source = storeDocSource(() => store)
    const listed = await source.notebooks()
    expect(listed.map((n) => n.name)).toEqual(listed.map((n) => n.id))
    expect(made).toHaveLength(40)
    expect(made.slice(0, 8).map((m) => m.frees)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(made.slice(8).every((m) => m.frees === 0)).toBe(true)
    source.close()
    expect(made.every((m) => m.frees === 1)).toBe(true)
  })

  it("listing more notebooks than the cache holds gives Loro's heap back", async () => {
    const store = newStore()
    seedNotebooks(store, 64)
    const source = storeDocSource(() => store)
    // 64 notebooks through 32 slots: every listing decodes and evicts all 64.
    const lists = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await source.notebooks()
        // Loro frees a doc's container handles from a finalizer task, so give it a real turn.
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    // Freed docs wait on their container handles' finalizers, so the heap first climbs to a plateau
    // (about 40 MB here after 600 listings) and only then stays flat; the slope after it is the check.
    await lists(600)
    const settled = loroHeapBytes()
    await lists(600)
    const perEvicted = (loroHeapBytes() - settled) / (600 * 64)
    expect(perEvicted, 'bytes of Loro heap kept per evicted notebook').toBeLessThan(512)
    source.close()
    // 1200 listings take about 6 s; the deadline is a hundred times that.
  }, 10 * 60_000)
})
