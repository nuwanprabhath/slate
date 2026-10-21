import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { PageDoc } from '../src/page'

function recordUpdates(doc: LoroDoc): Uint8Array[] {
  const updates: Uint8Array[] = []
  doc.subscribeLocalUpdates((u) => updates.push(u))
  return updates
}

describe('PageDoc', () => {
  it('adds a box with position, width, private=false and a content container', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 10, y: 20, width: 300 })
    const box = page.getBox(id)!
    expect(box).toMatchObject({ id, x: 10, y: 20, width: 300, private: false })
    expect(typeof box.contentId).toBe('string')
    expect(page.contentMap(id)?.id).toBe(box.contentId)
  })

  it('patches box fields', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 100 })
    page.updateBox(id, { x: 5, width: 250, private: true })
    expect(page.getBox(id)).toMatchObject({ x: 5, y: 0, width: 250, private: true })
  })

  it('moves several boxes in one commit', () => {
    const page = new PageDoc()
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    const b = page.addBox({ x: 0, y: 50, width: 100 })
    const updates = recordUpdates(page.doc)
    page.moveBoxes(new Map([[a, 10], [b, 60]]))
    expect(page.getBox(a)!.y).toBe(10)
    expect(page.getBox(b)!.y).toBe(60)
    expect(updates).toHaveLength(1)
  })

  it('deletes boxes', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 100 })
    page.deleteBox(id)
    expect(page.listBoxes()).toEqual([])
  })

  it('round-trips through exported updates', () => {
    const page = new PageDoc()
    const updates = recordUpdates(page.doc)
    const id = page.addBox({ x: 1, y: 2, width: 3 })
    page.updateBox(id, { private: true })
    const restored = PageDoc.fromUpdates(updates)
    expect(restored.listBoxes()).toEqual(page.listBoxes())
  })

  it('merges concurrent moves of different boxes', () => {
    const one = new PageDoc()
    const a = one.addBox({ x: 0, y: 0, width: 100 })
    const b = one.addBox({ x: 0, y: 100, width: 100 })
    const two = PageDoc.fromUpdates([one.doc.export({ mode: 'snapshot' })])
    one.updateBox(a, { x: 50 })
    two.updateBox(b, { y: 300 })
    one.doc.import(two.doc.export({ mode: 'update', from: one.doc.oplogVersion() }))
    two.doc.import(one.doc.export({ mode: 'update', from: two.doc.oplogVersion() }))
    expect(one.listBoxes()).toEqual(two.listBoxes())
    expect(one.getBox(a)!.x).toBe(50)
    expect(one.getBox(b)!.y).toBe(300)
  })
})
