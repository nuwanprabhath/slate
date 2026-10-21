// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { createNodeFromLoroObj, type LoroNode } from 'loro-prosemirror'
import { writeContent } from '../src/content'
import { schema } from '../src/extensions'
import { renderStaticHtml } from '../src/staticRender'

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
