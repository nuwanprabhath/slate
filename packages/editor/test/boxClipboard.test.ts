// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { PageDoc, type BoxCopy } from '@slate/core'
import { boxClipboard, clipHtml, clipMatches, clipText, copyBoxes, cutBoxes, duplicateBoxes, pasteBoxes } from '../src/boxClipboard'
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
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const boxWith = (session: PageSession, x: number, y: number, text: string) => session.createBoxWithContent(x, y, [para(text)])
const textOf = (session: PageSession, id: string) => session.page.copyBox(id)?.content
const saved = (persistence: DocPersistence & { data: Map<string, Uint8Array[]> }, pageId: string) => PageDoc.fromUpdates(persistence.data.get(pageDocId(pageId)) ?? [])

afterEach(() => boxClipboard.clear())

describe('box clipboard', () => {
  it('copy then paste makes copies with fresh ids, keeping their layout anchored at the point, as one undo step; again makes more', async () => {
    const session = await PageSession.open('p1', memoryPersistence())
    const a = boxWith(session, 100, 100, 'alpha')
    const b = boxWith(session, 300, 160, 'beta')
    copyBoxes(session, [a, b])
    const first = await pasteBoxes(session, { x: 20, y: 500 })
    expect(first).toHaveLength(2)
    expect(first).not.toContain(a)
    const placed = first.map((id) => session.page.getBox(id)!)
    expect(placed.map((p) => [p.x, p.y])).toEqual([
      [20, 500],
      [220, 560],
    ])
    expect(placed.map((p) => textOf(session, p.id))).toEqual([[para('alpha')], [para('beta')]])
    const second = await pasteBoxes(session, { x: 600, y: 40 })
    expect(second).toHaveLength(2)
    expect(session.getBoxes()).toHaveLength(6)
    session.undo()
    expect(session.getBoxes()).toHaveLength(4)
    session.undo()
    expect(session.getBoxes().map((x) => x.id).sort()).toEqual([a, b].sort())
    session.close()
  })

  it('duplicate makes copies 24px right and down as one undo step', async () => {
    const session = await PageSession.open('p1', memoryPersistence())
    const a = boxWith(session, 100, 100, 'alpha')
    const copies = duplicateBoxes(session, [a])
    expect(copies).toHaveLength(1)
    expect(session.page.getBox(copies[0]!)).toMatchObject({ x: 124, y: 124 })
    expect(textOf(session, copies[0]!)).toEqual([para('alpha')])
    session.undo()
    expect(session.getBoxes().map((x) => x.id)).toEqual([a])
    session.close()
  })

  it('cut marks the boxes; paste on the same page moves them (same ids) as one undo step, then pastes copies', async () => {
    const session = await PageSession.open('p1', memoryPersistence())
    const a = boxWith(session, 100, 100, 'alpha')
    const b = boxWith(session, 300, 160, 'beta')
    cutBoxes(session, [a, b])
    expect(boxClipboard.cutIn('p1')).toEqual(new Set([a, b]))
    expect(session.getBoxes()).toHaveLength(2)
    const moved = await pasteBoxes(session, { x: 10, y: 400 })
    expect(moved.sort()).toEqual([a, b].sort())
    expect(session.page.getBox(a)).toMatchObject({ x: 10, y: 400 })
    expect(session.page.getBox(b)).toMatchObject({ x: 210, y: 460 })
    expect(boxClipboard.cutIn('p1').size).toBe(0)
    session.undo()
    expect(session.page.getBox(a)).toMatchObject({ x: 100, y: 100 })
    expect(session.page.getBox(b)).toMatchObject({ x: 300, y: 160 })
    const again = await pasteBoxes(session, { x: 10, y: 400 })
    expect(again.filter((id) => id === a || id === b)).toEqual([])
    expect(session.getBoxes()).toHaveLength(4)
    session.close()
  })

  it('cut on one page and paste on another moves the boxes; undo puts them back on the source page, redo takes them again', async () => {
    const persistence = memoryPersistence()
    const source = await PageSession.open('p1', persistence)
    const a = boxWith(source, 100, 100, 'alpha')
    const stay = boxWith(source, 100, 400, 'stays')
    cutBoxes(source, [a])
    await tick()
    source.close()

    const target = await PageSession.open('p2', persistence)
    const pasted = await pasteBoxes(target, { x: 50, y: 60 })
    expect(pasted).toHaveLength(1)
    expect(target.page.getBox(pasted[0]!)).toMatchObject({ x: 50, y: 60 })
    expect(textOf(target, pasted[0]!)).toEqual([para('alpha')])
    expect(saved(persistence, 'p1').listBoxes().map((x) => x.id)).toEqual([stay])
    expect(boxClipboard.cutIn('p1').size).toBe(0)

    target.undo()
    expect(target.getBoxes()).toHaveLength(0)
    await expect.poll(() => saved(persistence, 'p1').listBoxes().map((x) => x.id).sort()).toEqual([a, stay].sort())
    expect(saved(persistence, 'p1').copyBox(a)).toMatchObject({ x: 100, y: 100, content: [para('alpha')] })

    target.redo()
    expect(target.getBoxes()).toHaveLength(1)
    await expect.poll(() => saved(persistence, 'p1').listBoxes().map((x) => x.id)).toEqual([stay])
    target.close()
  })

  it('editing a cut box, or a new copy, cancels the cut mark', async () => {
    const session = await PageSession.open('p1', memoryPersistence())
    const a = boxWith(session, 100, 100, 'alpha')
    cutBoxes(session, [a])
    boxClipboard.noteEdited('p1', a)
    expect(boxClipboard.cutIn('p1').size).toBe(0)
    cutBoxes(session, [a])
    copyBoxes(session, [a])
    expect(boxClipboard.cutIn('p1').size).toBe(0)
    expect(boxClipboard.get()?.mode).toBe('copy')
    session.close()
  })

  it('puts the boxes on the system clipboard as text and HTML, and knows when the system clipboard moved on', () => {
    const copies: BoxCopy[] = [
      { x: 300, y: 10, width: 100, private: false, content: [para('right')] },
      { x: 0, y: 10, width: 100, private: false, content: [para('left')] },
      { x: 0, y: 200, width: 100, private: false, content: [{ type: 'image', attrs: { src: 'slate-blob://blob/aa.png' } }] },
    ]
    expect(clipText(copies)).toBe('left\n\nright')
    const html = clipHtml(copies, 'tok123')
    expect(html).toContain('data-slate-boxes="tok123"')
    expect(html).toContain('<p>left</p>')
    expect(html).toContain('src="slate-blob://blob/aa.png"')
    expect(html.indexOf('left')).toBeLessThan(html.indexOf('right'))
    const clip = { text: 'left\n\nright', token: 'tok123' }
    expect(clipMatches(clip, 'left\r\n\r\nright', '')).toBe(true)
    expect(clipMatches(clip, 'something else', '')).toBe(false)
    expect(clipMatches({ text: '', token: 'tok123' }, '', '<div data-slate-boxes="tok123"><img></div>')).toBe(true)
    expect(clipMatches({ text: '', token: 'tok123' }, '', '')).toBe(false)
  })
})
