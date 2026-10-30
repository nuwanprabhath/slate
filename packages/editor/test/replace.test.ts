// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { contentToJSON, type PMJSON } from '@slate/core'
import { writeContent } from '../src/content'
import { buildExtensions } from '../src/extensions'
import { LoroBinding } from '../src/loroBinding'
import { PageSession, type DocPersistence } from '../src/PageSession'

function memoryPersistence(): DocPersistence {
  const data = new Map<string, Uint8Array[]>()
  return {
    load: async (id) => data.get(id) ?? [],
    append: async (id, update) => {
      data.set(id, [...(data.get(id) ?? []), update])
    },
  }
}

const plain = { matchCase: false, wholeWord: false, regex: false }
const para = (t: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })

async function sessionWith(...boxes: string[][]): Promise<{ session: PageSession; ids: string[] }> {
  const session = await PageSession.open(`p-${Math.random()}`, memoryPersistence())
  const ids = boxes.map((paras, i) => session.createBoxWithContent(0, i * 100, paras.map(para)))
  session.undoManager.clear()
  return { session, ids }
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
})
