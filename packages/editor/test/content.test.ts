// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { createNodeFromLoroObj, type LoroNode } from 'loro-prosemirror'
import { writeContent } from '../src/content'
import { schema } from '../src/extensions'
import { renderStaticHtml } from '../src/staticRender'
import { DOMParser, DOMSerializer } from '@tiptap/pm/model'

function seeded(): { doc: LoroDoc; root: LoroMap } {
  const doc = new LoroDoc()
  const root = doc.getMap('content')
  writeContent(root, [
    { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
    { type: 'image', attrs: { src: 'slate-blob://blob/x.png' } },
  ])
  doc.commit()
  return { doc, root }
}

describe('writeContent', () => {
  it('writes ProseMirror JSON in the layout loro-prosemirror reads', () => {
    const { root } = seeded()
    const node = createNodeFromLoroObj(schema, root as unknown as LoroNode, new Map())
    expect(node.type.name).toBe('doc')
    expect(node.childCount).toBe(3)
    expect(node.child(0).textContent).toBe('hello')
    expect(node.child(1).type.name).toBe('bulletList')
    expect(node.child(2).attrs.src).toBe('slate-blob://blob/x.png')
  })
})

describe('renderStaticHtml', () => {
  it('renders the box content to DOM', () => {
    const { doc, root } = seeded()
    const frag = renderStaticHtml(schema, doc, root.id, document)!
    const div = document.createElement('div')
    div.appendChild(frag)
    expect(div.querySelector('p')!.textContent).toBe('hello')
    expect(div.querySelector('ul li')!.textContent).toBe('item')
  })

  it('returns null for an empty box', () => {
    const doc = new LoroDoc()
    expect(renderStaticHtml(schema, doc, doc.getMap('empty').id, document)).toBeNull()
  })
})

describe('writeContent marks in the editor schema', () => {
  it('produces marks loro-prosemirror reads as ProseMirror marks', () => {
    const doc = new LoroDoc()
    const root = doc.getMap('content')
    writeContent(
      root,
      [{ type: 'paragraph', content: [{ type: 'text', text: 'B', marks: [{ type: 'bold' }] }, { type: 'text', text: 'L', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] }] }],
      doc,
    )
    doc.commit()
    const node = createNodeFromLoroObj(schema, root as unknown as LoroNode, new Map())
    const para = node.child(0)
    expect(para.child(0).marks.map((m) => m.type.name)).toEqual(['bold'])
    expect(para.child(1).marks[0]!.attrs.href).toBe('https://x.dev')
  })
})

describe('list styles', () => {
  const item = { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }

  it('round-trips listStyle through Loro and renders it as list-style-type', () => {
    const doc = new LoroDoc()
    const root = doc.getMap('content')
    writeContent(root, [
      { type: 'orderedList', attrs: { start: 1, listStyle: 'lower-alpha' }, content: [item] },
      { type: 'bulletList', attrs: { listStyle: 'square' }, content: [item] },
    ])
    doc.commit()
    const node = createNodeFromLoroObj(schema, root as unknown as LoroNode, new Map())
    expect(node.child(0).attrs.listStyle).toBe('lower-alpha')
    expect(node.child(1).attrs.listStyle).toBe('square')
    const div = document.createElement('div')
    div.appendChild(renderStaticHtml(schema, doc, root.id, document)!)
    const ol = div.querySelector('ol')!
    expect(ol.style.listStyleType).toBe('lower-alpha')
    expect(ol.getAttribute('data-list-style')).toBe('lower-alpha')
    expect(div.querySelector('ul')!.style.listStyleType).toBe('square')
  })

  it('parses data-list-style back, and leaves plain lists unstyled', () => {
    const html = document.createElement('div')
    html.innerHTML = '<ol data-list-style="upper-roman"><li><p>x</p></li></ol><ul><li><p>y</p></li></ul>'
    const parsed = DOMParser.fromSchema(schema).parse(html)
    expect(parsed.child(0).attrs.listStyle).toBe('upper-roman')
    expect(parsed.child(1).attrs.listStyle).toBeNull()
    const out = document.createElement('div')
    out.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(parsed.content, { document }))
    expect(out.querySelector('ul')!.hasAttribute('style')).toBe(false)
  })
})
