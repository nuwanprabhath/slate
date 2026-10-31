// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { LoroText } from 'loro-crdt'
import { Editor } from '@tiptap/core'
import { contentToJSON, PageDoc, type PMJSON } from '@slate/core'
import { writeContent } from '../src/content'
import { buildExtensions } from '../src/extensions'
import { LoroBinding } from '../src/loroBinding'
import { PageSession, type DocPersistence } from '../src/PageSession'

function memoryPersistence(): DocPersistence & { data: Map<string, Uint8Array[]> } {
  const data = new Map<string, Uint8Array[]>()
  return {
    data,
    load: async (id) => data.get(id) ?? [],
    append: async (id, update) => {
      data.set(id, [...(data.get(id) ?? []), update])
    },
  }
}

const plain = { matchCase: false, wholeWord: false, regex: false }
const para = (t: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })

async function sessionWith(...boxes: string[][]): Promise<{ session: PageSession; ids: string[]; persistence: ReturnType<typeof memoryPersistence> }> {
  const persistence = memoryPersistence()
  const session = await PageSession.open(`p-${Math.random()}`, persistence)
  const ids = boxes.map((paras, i) => session.createBoxWithContent(0, i * 100, paras.map(para)))
  session.undoManager.clear()
  return { session, ids, persistence }
}

const texts = (session: PageSession, id: string) => (contentToJSON(session.page.contentMap(id)!)!.content ?? []).map((p) => p.content?.[0]?.text ?? '')

describe('PageSession.replace', () => {
  it('replaces across boxes as one undo step', async () => {
    const { session, ids } = await sessionWith(['cat'], ['a cat', 'Cat'])
    expect(session.replace('cat', plain, 'dog', { preserveCase: true })).toBe(3)
    expect(texts(session, ids[1]!)).toEqual(['a dog', 'Dog'])
    expect(session.undo()).toBe(true)
    expect(texts(session, ids[0]!)).toEqual(['cat'])
    expect(texts(session, ids[1]!)).toEqual(['a cat', 'Cat'])
    expect(session.undoManager.canUndo()).toBe(false)
    session.close()
  })

  it('is its own undo step, apart from an edit just before it', async () => {
    const { session, ids } = await sessionWith(['cat'])
    const root = session.page.contentMap(ids[0]!)!
    writeContent(root, [para('cat cat')], session.doc)
    session.doc.commit()
    session.replace('cat', plain, 'dog', {})
    expect(texts(session, ids[0]!)).toEqual(['dog dog'])
    session.undo()
    expect(texts(session, ids[0]!)).toEqual(['cat cat'])
    session.close()
  })

  it('replaces only the picked occurrence', async () => {
    const { session, ids } = await sessionWith(['x x x'])
    expect(session.replace('x', plain, 'y', { only: (boxId, n) => boxId === ids[0] && n === 1 })).toBe(1)
    expect(texts(session, ids[0]!)).toEqual(['x y x'])
    session.close()
  })

  it('adds no undo step when nothing matched', async () => {
    const { session } = await sessionWith(['cat'])
    expect(session.replace('dog', plain, 'cat', {})).toBe(0)
    expect(session.undoManager.canUndo()).toBe(false)
    session.close()
  })

  it('redraws a mounted box editor', async () => {
    const { session, ids } = await sessionWith(['hello cat'])
    const box = session.getBoxes().find((b) => b.id === ids[0])!
    const editor = new Editor({ extensions: [...buildExtensions({ autoBullets: false }), LoroBinding.configure({ doc: session.doc, containerId: box.contentId })] })
    await new Promise((r) => setTimeout(r, 0))
    expect(editor.getText()).toBe('hello cat')
    session.replace('cat', plain, 'dog', {})
    expect(editor.getText()).toBe('hello dog')
    editor.destroy()
    session.close()
  })

  it('is all or nothing: a failure while writing leaves no change, no undo step and nothing saved', async () => {
    const { session, ids, persistence } = await sessionWith(['cat'], ['cat'])
    const real = LoroText.prototype.applyDelta
    let calls = 0
    const spy = vi.spyOn(LoroText.prototype, 'applyDelta').mockImplementation(function (this: LoroText, delta) {
      // Edits are written back to front: the second write is the first box's.
      if (++calls === 2) throw new Error('write failed')
      return real.call(this, delta)
    })
    expect(() => session.replace('cat', plain, 'dog', {})).toThrow('write failed')
    spy.mockRestore()
    expect(texts(session, ids[0]!)).toEqual(['cat'])
    expect(texts(session, ids[1]!)).toEqual(['cat'])
    expect(session.undoManager.canUndo()).toBe(false)
    // The next ordinary commit saves nothing of the failed replace.
    session.bringToFront(ids[0]!)
    await new Promise((r) => setTimeout(r, 0))
    const stored = PageDoc.fromUpdates(persistence.data.get(`page:${session.pageId}`)!)
    expect(contentToJSON(stored.contentMap(ids[1]!)!)!.content![0]!.content![0]!.text).toBe('cat')
    session.close()
  })

  it('appends nothing at all when a write fails: the edits are tried on a fork of the page first', async () => {
    const { session, ids, persistence } = await sessionWith(['cat'], ['cat'])
    await new Promise((r) => setTimeout(r, 0))
    const key = `page:${session.pageId}`
    const storedBefore = persistence.data.get(key)?.length ?? 0
    const real = LoroText.prototype.applyDelta
    let calls = 0
    const spy = vi.spyOn(LoroText.prototype, 'applyDelta').mockImplementation(function (this: LoroText, delta) {
      if (++calls === 2) throw new Error('write failed')
      return real.call(this, delta)
    })
    expect(() => session.replace('cat', plain, 'dog', {})).toThrow('write failed')
    spy.mockRestore()
    await new Promise((r) => setTimeout(r, 0))
    // Nothing to persist, so a lock or crash at any point cannot leave half the replace stored.
    expect(persistence.data.get(key)?.length ?? 0).toBe(storedBefore)
    expect(texts(session, ids[0]!)).toEqual(['cat'])
    // The real doc is untouched, so a replace right after works and is one undo step.
    expect(session.replace('cat', plain, 'dog', {})).toBe(2)
    expect(texts(session, ids[0]!)).toEqual(['dog'])
    session.undoManager.undo()
    expect(texts(session, ids[0]!)).toEqual(['cat'])
    expect(texts(session, ids[1]!)).toEqual(['cat'])
    session.close()
  })

  it('pushes the boxes below when a replace grows a box, as typing does', async () => {
    const { session, ids } = await sessionWith(['cat'], ['below'])
    const box = session.getBoxes().find((b) => b.id === ids[0])!
    const editor = new Editor({ extensions: [...buildExtensions({ autoBullets: false }), LoroBinding.configure({ doc: session.doc, containerId: box.contentId })] })
    await new Promise((r) => setTimeout(r, 0))
    session.reportHeight(ids[0]!, 40)
    session.reportHeight(ids[1]!, 40)
    session.replace('cat', plain, 'a much longer text that wraps onto more lines', {})
    session.reportHeight(ids[0]!, 140)
    expect(session.page.getBox(ids[1]!)!.y).toBeGreaterThan(100)
    editor.destroy()
    session.close()
  })
})
