import { describe, expect, it, vi } from 'vitest'
import { LoroList, LoroMap, LoroText } from 'loro-crdt'
import { agentBoxes, agentPageMarkdown, PRIVATE_PLACEHOLDER } from '../src/agentView'
import { contentToJSON, writeContent } from '../src/content'
import { PageDoc } from '../src/page'

function pageWith(boxes: Array<{ y: number; x?: number; text: string; private?: boolean }>): PageDoc {
  const page = new PageDoc()
  for (const b of boxes) {
    const id = page.addBox({ x: b.x ?? 0, y: b.y, width: 300 })
    writeContent(page.contentMap(id)!, [{ type: 'paragraph', content: [{ type: 'text', text: b.text }] }])
    page.doc.commit()
    if (b.private) page.updateBox(id, { private: true })
  }
  return page
}

describe('agent view', () => {
  it('orders boxes top-to-bottom and renders Markdown', () => {
    const page = pageWith([{ y: 300, text: 'second' }, { y: 10, text: 'first' }])
    expect(agentBoxes(page).map((b) => b.markdown)).toEqual(['first', 'second'])
    expect(agentPageMarkdown(page)).toBe('first\n\n---\n\nsecond')
  })

  it('never exposes a private box (security boundary)', () => {
    const page = pageWith([{ y: 0, text: 'public note' }, { y: 100, text: 'hunter2 secret token', private: true }])
    const boxes = agentBoxes(page)
    expect(boxes[1]).toMatchObject({ private: true, markdown: null })
    expect(JSON.stringify(boxes)).not.toContain('hunter2')
    const md = agentPageMarkdown(page)
    expect(md).toContain('public note')
    expect(md).toContain(PRIVATE_PLACEHOLDER)
    expect(md).not.toContain('hunter2')
  })

  it('reads marks stored on Loro text', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 300 })
    writeContent(page.contentMap(id)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'plain bold' }] }])
    page.doc.configTextStyle({ bold: { expand: 'after' } })
    const para = (page.contentMap(id)!.get('children') as LoroList).get(0) as LoroMap
    const text = (para.get('children') as LoroList).get(0) as LoroText
    text.mark({ start: 6, end: 10 }, 'bold', true)
    page.doc.commit()
    expect(agentPageMarkdown(page)).toBe('plain **bold**')
  })

  it('returns null content for an empty box', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 100 })
    expect(contentToJSON(page.contentMap(id)!)).toBeNull()
  })
})

describe('private boxes are never opened', () => {
  it('does not touch the content container of a private box', () => {
    const page = pageWith([
      { y: 0, text: 'public note' },
      { y: 100, text: 'hunter2', private: true },
    ])
    const privateId = page.listBoxes().find((b) => b.private)!.id
    const spy = vi.spyOn(page, 'contentMap')
    agentBoxes(page)
    agentPageMarkdown(page)
    expect(spy.mock.calls.map(([id]) => id)).not.toContain(privateId)
  })
})
