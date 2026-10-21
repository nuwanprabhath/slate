import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { NotebookDoc, SECTION_COLORS } from '../src/tree'

const titles = (nb: NotebookDoc) => nb.items().map((i) => i.title)

describe('NotebookDoc', () => {
  it('stores the notebook name', () => {
    const nb = NotebookDoc.create('Work')
    expect(nb.name).toBe('Work')
    nb.rename('Personal')
    expect(nb.name).toBe('Personal')
  })

  it('builds groups, sections and pages in order', () => {
    const nb = NotebookDoc.create('N')
    const group = nb.addSectionGroup('Projects')
    const s1 = nb.addSection('TERN')
    const s2 = nb.addSection('AdNav', group)
    const { pageId } = nb.addPage(s1, 'Releases')
    nb.addPage(s1, 'Hot fixes')
    const items = nb.items()
    expect(items.map((i) => [i.kind, i.title])).toEqual([['sectionGroup', 'Projects'], ['section', 'TERN']])
    expect(items[0].children.map((c) => c.id)).toEqual([s2])
    expect(items[1].color).toBe(SECTION_COLORS[0])
    expect(items[1].children.map((c) => [c.title, c.level])).toEqual([['Releases', 0], ['Hot fixes', 0]])
    expect(items[1].children[0].pageId).toBe(pageId)
  })

  it('rejects invalid placements', () => {
    const nb = NotebookDoc.create('N')
    const group = nb.addSectionGroup('G')
    const section = nb.addSection('S')
    const { id: page } = nb.addPage(section)
    expect(() => nb.addPage(group)).toThrow()
    expect(() => nb.addSection('x', section)).toThrow()
    expect(() => nb.moveInto(page, undefined)).toThrow()
    expect(() => nb.moveBefore(section, page)).toThrow()
  })

  it('reorders siblings with moveBefore and moveAfter', () => {
    const nb = NotebookDoc.create('N')
    const a = nb.addSection('A')
    nb.addSection('B')
    const c = nb.addSection('C')
    nb.moveBefore(c, a)
    expect(titles(nb)).toEqual(['C', 'A', 'B'])
    nb.moveAfter(c, nb.items()[2].id)
    expect(titles(nb)).toEqual(['A', 'B', 'C'])
  })

  it('moves sections into groups and pages between sections', () => {
    const nb = NotebookDoc.create('N')
    const group = nb.addSectionGroup('G')
    const s1 = nb.addSection('S1')
    const s2 = nb.addSection('S2')
    const { id: page } = nb.addPage(s1, 'P')
    nb.moveInto(s1, group)
    nb.moveInto(page, s2)
    expect(nb.get(group)!.children.map((c) => c.id)).toEqual([s1])
    expect(nb.get(s2)!.children.map((c) => c.id)).toEqual([page])
  })

  it('updates title, colour and clamps level', () => {
    const nb = NotebookDoc.create('N')
    const s = nb.addSection('S')
    const { id } = nb.addPage(s)
    nb.setTitle(id, 'Renamed')
    nb.setColor(s, '#123456')
    nb.setLevel(id, 7)
    expect(nb.get(id)).toMatchObject({ title: 'Renamed', level: 2 })
    expect(nb.get(s)!.color).toBe('#123456')
    nb.setLevel(id, -3)
    expect(nb.get(id)!.level).toBe(0)
  })

  it('deletes a subtree and returns its page ids', () => {
    const nb = NotebookDoc.create('N')
    const group = nb.addSectionGroup('G')
    const s = nb.addSection('S', group)
    const p1 = nb.addPage(s).pageId
    const p2 = nb.addPage(s).pageId
    expect(nb.allPageIds().sort()).toEqual([p1, p2].sort())
    expect(nb.delete(group).sort()).toEqual([p1, p2].sort())
    expect(nb.items()).toEqual([])
    expect(nb.get(s)).toBeUndefined()
  })

  it('round-trips through updates and converges across peers', () => {
    const one = NotebookDoc.create('N')
    const s = one.addSection('S')
    const two = NotebookDoc.fromUpdates([one.doc.export({ mode: 'snapshot' })])
    one.addPage(s, 'from one')
    two.addPage(s, 'from two')
    one.doc.import(two.doc.export({ mode: 'update', from: one.doc.oplogVersion() }))
    two.doc.import(one.doc.export({ mode: 'update', from: two.doc.oplogVersion() }))
    expect(one.items()).toEqual(two.items())
    expect(one.get(s)!.children).toHaveLength(2)
    expect(new NotebookDoc(new LoroDoc()).items()).toEqual([])
  })
})
