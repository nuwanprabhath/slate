import { describe, expect, it } from 'vitest'
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
})
