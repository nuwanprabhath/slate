import { describe, expect, it } from 'vitest'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { PageDoc } from '../src/page'
import { writeContent } from '../src/content'

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

  it('keeps the needs-layout flag in the doc, off by default', () => {
    const one = new PageDoc()
    expect(one.needsLayout()).toBe(false)
    one.setNeedsLayout(true)
    expect(one.needsLayout()).toBe(true)
    const two = PageDoc.fromUpdates([one.doc.export({ mode: 'update' })])
    expect(two.needsLayout()).toBe(true)
    two.setNeedsLayout(false)
    expect(two.needsLayout()).toBe(false)
  })
})

describe('PageDoc stacking and min height', () => {
  it('reads a box saved without z or height as z 0 and no min height', () => {
    const doc = new LoroDoc()
    const m = doc.getMap('boxes').setContainer('old', new LoroMap())
    m.set('x', 1)
    m.set('y', 2)
    m.set('width', 300)
    m.set('private', false)
    m.setContainer('content', new LoroMap())
    doc.commit()
    const box = new PageDoc(doc).getBox('old')!
    expect(box.z).toBe(0)
    expect(box.height).toBeUndefined()
  })

  it('puts a new box on top', () => {
    const page = new PageDoc()
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    const b = page.addBox({ x: 0, y: 0, width: 100 })
    expect(page.getBox(b)!.z).toBeGreaterThan(page.getBox(a)!.z)
  })

  it('brings a box to the front, and does nothing when it already is', () => {
    const page = new PageDoc()
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    const b = page.addBox({ x: 0, y: 0, width: 100 })
    expect(page.bringToFront(a)).toBe(true)
    expect(page.getBox(a)!.z).toBeGreaterThan(page.getBox(b)!.z)
    const updates = recordUpdates(page.doc)
    expect(page.bringToFront(a)).toBe(false)
    expect(updates).toHaveLength(0)
  })

  it('stacks boxes by z, then id', () => {
    const page = new PageDoc()
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    const b = page.addBox({ x: 0, y: 0, width: 100 })
    page.bringToFront(a)
    expect(page.stackOrder()).toEqual([b, a])
  })

  it('a bring-to-front survives a reload from updates', () => {
    const page = new PageDoc()
    const updates = recordUpdates(page.doc)
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    page.addBox({ x: 0, y: 0, width: 100 })
    page.bringToFront(a)
    expect(PageDoc.fromUpdates(updates).stackOrder().at(-1)).toBe(a)
  })

  it('stores and clears a min height', () => {
    const page = new PageDoc()
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    page.updateBox(a, { height: 240 })
    expect(page.getBox(a)!.height).toBe(240)
    page.updateBox(a, { height: null })
    expect(page.getBox(a)!.height).toBeUndefined()
  })

  it('patches several boxes in one commit', () => {
    const page = new PageDoc()
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    const b = page.addBox({ x: 0, y: 50, width: 100 })
    const updates = recordUpdates(page.doc)
    page.updateBoxes(new Map([[a, { x: 10, y: 20 }], [b, { x: 30 }]]))
    expect(page.getBox(a)).toMatchObject({ x: 10, y: 20 })
    expect(page.getBox(b)).toMatchObject({ x: 30, y: 50 })
    expect(updates).toHaveLength(1)
  })

  it('deletes several boxes in one commit', () => {
    const page = new PageDoc()
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    const b = page.addBox({ x: 0, y: 50, width: 100 })
    const updates = recordUpdates(page.doc)
    page.deleteBoxes([a, b])
    expect(page.listBoxes()).toHaveLength(0)
    expect(updates).toHaveLength(1)
  })
})

describe('PageDoc box copies', () => {
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'bold', attrs: {} }] }] })

  it('copies a box: its place, size, privacy and content', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 10, y: 20, width: 300 })
    page.updateBox(id, { private: true, height: 90 })
    writeContent(page.contentMap(id)!, [para('hello'), { type: 'image', attrs: { src: 'slate-blob:abc' } }], page.doc)
    page.doc.commit()
    expect(page.copyBox(id)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 90,
      private: true,
      content: [para('hello'), { type: 'image', attrs: { src: 'slate-blob:abc' } }],
    })
    expect(page.copyBox('missing')).toBeUndefined()
  })

  it('adds copies in one commit, in front, with fresh ids unless ids are given', () => {
    const page = new PageDoc()
    const first = page.addBox({ x: 0, y: 0, width: 100 })
    const copy = { x: 40, y: 50, width: 200, private: false, content: [para('one')] }
    const commits: number[] = []
    page.doc.subscribeLocalUpdates(() => commits.push(1))
    const ids = page.addBoxCopies([copy, { ...copy, x: 60, height: 30 }])
    expect(commits).toHaveLength(1)
    expect(ids).toHaveLength(2)
    expect(ids).not.toContain(first)
    expect(new Set(ids).size).toBe(2)
    expect(page.copyBox(ids[0]!)).toEqual(copy)
    expect(page.copyBox(ids[1]!)).toEqual({ ...copy, x: 60, height: 30 })
    expect(page.stackOrder()).toEqual([first, ids[0], ids[1]])
    const kept = page.addBoxCopies([copy], ['given-id'])
    expect(kept).toEqual(['given-id'])
    expect(page.copyBox('given-id')).toEqual(copy)
  })

  it('copies an empty box as no content', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 100 })
    expect(page.copyBox(id)?.content).toEqual([])
    const [again] = page.addBoxCopies([page.copyBox(id)!])
    expect(page.copyBox(again!)?.content).toEqual([])
  })
})
