import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { SaveQueue, allSavesIdle, saveStatus } from '../src/saveQueue'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** A store that can be set to reject, and records each update it accepted. */
function sink(): { append: (id: string, u: Uint8Array) => Promise<void>; stored: Uint8Array[]; fail: boolean; calls: number } {
  const s = {
    stored: [] as Uint8Array[],
    fail: false,
    calls: 0,
    append: async (_id: string, u: Uint8Array) => {
      s.calls++
      if (s.fail) throw new Error('rejected')
      s.stored.push(u)
    },
  }
  return s
}

function edit(doc: LoroDoc, text: string): void {
  doc.getText('t').insert(doc.getText('t').length, text)
  doc.commit()
}

describe('SaveQueue', () => {
  it('writes what every accepted update adds up to, in order', async () => {
    const doc = new LoroDoc()
    const store = sink()
    const q = new SaveQueue('d', doc, store)
    edit(doc, 'a')
    edit(doc, 'b')
    await q.idle()
    edit(doc, 'c')
    await q.idle()
    const reloaded = new LoroDoc()
    reloaded.importBatch(store.stored)
    expect(reloaded.getText('t').toString()).toBe('abc')
    expect(q.state).toBe('saved')
    q.close()
  })

  it('re-exports from the last acknowledged version, so a rejected append loses nothing', async () => {
    const doc = new LoroDoc()
    const store = sink()
    const q = new SaveQueue('d', doc, store)
    store.fail = true
    edit(doc, 'one ')
    await tick(10)
    expect(q.state).toBe('unsaved')
    expect(store.stored).toHaveLength(0)
    edit(doc, 'two ')
    store.fail = false
    await q.idle(3000)
    const reloaded = new LoroDoc()
    reloaded.importBatch(store.stored)
    expect(reloaded.getText('t').toString()).toBe('one two ')
    q.close()
  })

  it('backs off instead of spinning while the store keeps rejecting', async () => {
    const doc = new LoroDoc()
    const store = sink()
    store.fail = true
    const q = new SaveQueue('d', doc, store)
    edit(doc, 'x')
    await tick(400)
    // 250 ms then 500 ms: the first attempt plus the first retry, not a tight loop.
    expect(store.calls).toBeGreaterThanOrEqual(2)
    expect(store.calls).toBeLessThan(6)
    q.close()
  })

  it('reports the worst open document and waits for all of them', async () => {
    const good = new LoroDoc()
    const bad = new LoroDoc()
    const ok = sink()
    const broken = sink()
    broken.fail = true
    const a = new SaveQueue('a', good, ok)
    const b = new SaveQueue('b', bad, broken)
    expect(saveStatus.state()).toBe('saved')
    edit(good, 'g')
    edit(bad, 'b')
    await tick(10)
    expect(saveStatus.state()).toBe('unsaved')
    expect(saveStatus.error()).toContain('rejected')
    broken.fail = false
    await allSavesIdle(3000)
    expect(saveStatus.state()).toBe('saved')
    expect(saveStatus.error()).toBeUndefined()
    a.close()
    b.close()
    expect(saveStatus.state()).toBe('saved')
  })

  it('tells watchers when the state changes', async () => {
    const doc = new LoroDoc()
    const store = sink()
    store.fail = true
    const q = new SaveQueue('d', doc, store)
    const seen: string[] = []
    const off = saveStatus.subscribe(() => seen.push(saveStatus.state()))
    edit(doc, 'x')
    await tick(10)
    expect(seen).toContain('saving')
    expect(seen).toContain('unsaved')
    off()
    q.close()
  })

  it('still writes the edit made just before it was closed', async () => {
    const doc = new LoroDoc()
    const store = sink()
    const q = new SaveQueue('d', doc, store)
    edit(doc, 'last')
    q.close()
    await tick(10)
    const reloaded = new LoroDoc()
    reloaded.importBatch(store.stored)
    expect(reloaded.getText('t').toString()).toBe('last')
  })
})
