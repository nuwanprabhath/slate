import { describe, expect, it } from 'vitest'
import { PageDoc, contentToJSON } from '@slate/core'
import { writeContent } from '../src/content'
import { PageSession, pageDocId, type DocPersistence } from '../src/PageSession'

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

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('PageSession', () => {
  it('persists local changes and reloads them', async () => {
    const persistence = memoryPersistence()
    const first = await PageSession.open('p1', persistence)
    const id = first.createBox(10, 20)
    await tick()
    expect(persistence.data.get(pageDocId('p1'))!.length).toBeGreaterThan(0)
    first.close()
    const second = await PageSession.open('p1', persistence)
    expect(second.getBoxes().map((b) => b.id)).toEqual([id])
    second.close()
  })

  it('notifies subscribers with a fresh snapshot', async () => {
    const session = await PageSession.open('p2', memoryPersistence())
    const before = session.getBoxes()
    let calls = 0
    session.subscribe(() => calls++)
    session.createBox(0, 0)
    await tick()
    expect(calls).toBeGreaterThan(0)
    expect(session.getBoxes()).not.toBe(before)
    expect(session.getBoxes()).toHaveLength(1)
    session.close()
  })

  it('pushes boxes below only when growth follows a local edit', async () => {
    const session = await PageSession.open('p3', memoryPersistence())
    const a = session.createBox(0, 0, 300)
    const b = session.createBox(0, 200, 300)
    await tick()
    session.reportHeight(a, 100)
    session.reportHeight(b, 50)
    session.reportHeight(a, 160) // no local edit noted: e.g. remote change or undo
    await tick()
    expect(session.getBoxes().find((x) => x.id === b)!.y).toBe(200)
    session.noteLocalEdit(a)
    session.reportHeight(a, 200)
    await tick()
    expect(session.getBoxes().find((x) => x.id === b)!.y).toBe(240)
    session.close()
  })

  it('pushes even when the height report arrives long after the edit (slow machine)', async () => {
    const session = await PageSession.open('p6', memoryPersistence())
    const a = session.createBox(0, 0, 300)
    const b = session.createBox(0, 200, 300)
    await tick()
    session.reportHeight(a, 100)
    session.reportHeight(b, 50)
    session.noteLocalEdit(a)
    await new Promise((r) => setTimeout(r, 700))
    session.reportHeight(a, 150)
    await tick()
    expect(session.getBoxes().find((x) => x.id === b)!.y).toBe(250)
    session.close()
  })

  it('does not push when a remote or undo change follows the last local edit', async () => {
    const session = await PageSession.open('p7', memoryPersistence())
    const a = session.createBox(0, 0, 300)
    const b = session.createBox(0, 200, 300)
    await tick()
    session.reportHeight(a, 100)
    session.reportHeight(b, 50)
    session.noteLocalEdit(a) // typed without changing height…
    session.noteRemoteEdit(a) // …then an undo or remote change grew the box
    session.reportHeight(a, 180)
    await tick()
    expect(session.getBoxes().find((x) => x.id === b)!.y).toBe(200)
    session.close()
  })

  it('keeps the same box snapshot when only box content changes (typing must not rebuild 200 boxes)', async () => {
    const session = await PageSession.open('p8', memoryPersistence())
    const id = session.createBox(0, 0)
    await tick()
    const before = session.getBoxes()
    let calls = 0
    session.subscribe(() => calls++)
    writeContent(session.page.contentMap(id)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'typed' }] }])
    session.doc.commit()
    await tick()
    expect(session.getBoxes()).toBe(before)
    expect(calls).toBe(0)
    session.page.updateBox(id, { x: 40 })
    await tick()
    expect(session.getBoxes()).not.toBe(before)
    expect(calls).toBe(1)
    session.close()
  })

  it('deletes an empty box without making an undo step', async () => {
    const session = await PageSession.open('p-empty', memoryPersistence())
    const empty = session.createBox(0, 200)
    await tick()
    expect(session.deleteIfEmpty(empty)).toBe(true)
    expect(session.page.getBox(empty)).toBeUndefined()
    // Undo and redo step over the creation; neither may bring back the deleted empty box.
    session.undo()
    expect(session.page.getBox(empty)).toBeUndefined()
    session.redo()
    expect(session.page.getBox(empty)).toBeUndefined()
    session.close()
  })

  it('deleting a box is an undo step that brings its text back', async () => {
    const session = await PageSession.open('p-del', memoryPersistence())
    const id = session.createBoxWithContent(0, 0, [{ type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] }])
    session.deleteBox(id) // straight after the edit: still its own undo step
    expect(session.page.getBox(id)).toBeUndefined()
    expect(session.undo()).toBe(true)
    expect(session.page.getBox(id)).toBeDefined()
    expect(JSON.stringify(contentToJSON(session.page.contentMap(id)!))).toContain('keep me')
    session.close()
  })

  it('takes back a move between two boxes (a drag from one box to another) in one undo', async () => {
    const session = await PageSession.open('p-drag', memoryPersistence())
    const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    const from = session.createBoxWithContent(0, 0, [para('before'), { type: 'image', attrs: { src: 'slate-blob://a' } }])
    const to = session.createBoxWithContent(0, 200, [para('target')])
    const text = (id: string) => JSON.stringify(contentToJSON(session.page.contentMap(id)!))
    session.oneUndoStep(() => {
      // Each box's editor commits its own change, as two dispatches do.
      writeContent(session.page.contentMap(to)!, [para('target'), { type: 'image', attrs: { src: 'slate-blob://a' } }], session.doc)
      session.doc.commit()
      writeContent(session.page.contentMap(from)!, [para('before')], session.doc)
      session.doc.commit()
    })
    expect(text(from)).not.toContain('slate-blob')
    expect(session.undo()).toBe(true)
    expect(text(from)).toContain('slate-blob')
    expect(text(to)).not.toContain('slate-blob')
    session.close()
  })

  it('never deletes a box with content, an image or the private flag', async () => {
    const session = await PageSession.open('p-keep', memoryPersistence())
    const text = session.createBoxWithContent(0, 0, [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }])
    const image = session.createBoxWithContent(0, 100, [{ type: 'image', attrs: { src: 'slate-blob://a' } }])
    const priv = session.createBox(0, 200)
    session.page.updateBox(priv, { private: true })
    for (const id of [text, image, priv]) expect(session.deleteIfEmpty(id)).toBe(false)
    expect(session.getBoxes()).toHaveLength(3)
    session.close()
  })

  it('undoes and redoes page changes', async () => {
    const session = await PageSession.open('p4', memoryPersistence())
    session.createBox(0, 0)
    await tick()
    expect(session.undo()).toBe(true)
    await tick()
    expect(session.getBoxes()).toHaveLength(0)
    expect(session.redo()).toBe(true)
    await tick()
    expect(session.getBoxes()).toHaveLength(1)
    session.close()
  })

  it('creates a box with initial content', async () => {
    const session = await PageSession.open('p5', memoryPersistence())
    const id = session.createBoxWithContent(5, 5, [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }])
    expect(session.page.contentMap(id)!.size).toBeGreaterThan(0)
    session.close()
  })

  it('imports updates written by another process (an agent) and shows the new box', async () => {
    const persistence = memoryPersistence()
    const session = await PageSession.open('p9', persistence)
    const other = PageDoc.fromUpdates(persistence.data.get(pageDocId('p9')) ?? [])
    const from = other.doc.oplogVersion()
    other.addBox({ x: 40, y: 400, width: 300 })
    session.importExternal([other.doc.export({ mode: 'update', from })])
    await tick()
    expect(session.getBoxes()).toHaveLength(1)
    session.close()
  })
})

describe('PageSession layout settle', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function openOverlapping(flagged: boolean) {
    const seed = new PageDoc()
    const a = seed.addBox({ x: 0, y: 0, width: 200 })
    const b = seed.addBox({ x: 0, y: 20, width: 200 })
    if (flagged) seed.setNeedsLayout(true)
    const persistence = memoryPersistence()
    persistence.data.set(pageDocId('p'), [seed.doc.export({ mode: 'update' })])
    const session = await PageSession.open('p', persistence)
    return { session, a, b }
  }

  it('settles a flagged page once every box has reported a height', async () => {
    const { session, a, b } = await openOverlapping(true)
    session.reportHeight(a, 100)
    await wait(300)
    expect(session.page.getBox(b)!.y).toBe(20) // b has not reported yet
    session.reportHeight(b, 50)
    await wait(300)
    expect(session.page.getBox(b)!.y).toBe(112)
    expect(session.page.getBox(a)!.y).toBe(0)
    session.close()
  })

  it('leaves an unflagged page alone', async () => {
    const { session, a, b } = await openOverlapping(false)
    session.reportHeight(a, 100)
    session.reportHeight(b, 50)
    await wait(300)
    expect(session.page.getBox(b)!.y).toBe(20)
    session.close()
  })

  it('clears the flag when the session closes', async () => {
    const { session } = await openOverlapping(true)
    session.close()
    expect(session.page.needsLayout()).toBe(false)
  })

  it('does not undo a settle', async () => {
    const { session, a, b } = await openOverlapping(true)
    session.reportHeight(a, 100)
    session.reportHeight(b, 50)
    await wait(300)
    session.undo()
    expect(session.page.getBox(b)!.y).toBe(112)
    session.close()
  })
})
