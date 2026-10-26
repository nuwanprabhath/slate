import { describe, expect, it } from 'vitest'
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt'
import { contentToJSON, writeContent } from '../src/content'

describe('writeContent marks', () => {
  it('round-trips text marks through contentToJSON', () => {
    const doc = new LoroDoc()
    const root = doc.getMap('c')
    writeContent(
      root,
      [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' red', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] },
            { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] },
          ],
        },
      ],
      doc,
    )
    doc.commit()
    const para = contentToJSON(root)!.content![0]
    expect(para!.content).toEqual([
      { type: 'text', text: 'plain ' },
      { type: 'text', text: 'bold', marks: [{ type: 'bold', attrs: {} }] },
      { type: 'text', text: ' red', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] },
      { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] },
    ])
  })

  it('makes link non-inclusive and bold expand after', () => {
    const doc = new LoroDoc()
    const root = doc.getMap('c')
    writeContent(
      root,
      [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'h' } }, { type: 'bold' }] }] }],
      doc,
    )
    doc.commit()
    const para = ((root.get('children') as LoroList).get(0) as LoroMap).get('children') as LoroList
    const text = para.get(0) as LoroText
    text.insert(1, 'X')
    expect(text.toDelta()).toEqual([
      { insert: 'a', attributes: { link: { href: 'h' }, bold: {} } },
      { insert: 'X', attributes: { bold: {} } },
    ])
  })
})
