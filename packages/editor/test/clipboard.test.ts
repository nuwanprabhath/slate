// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { cleanPastedHtml, makeClipboardSerializer, serializeSliceAsText, stripCopiedStyles } from '../src/clipboard'
import { schema } from '../src/extensions'

describe('cleanPastedHtml', () => {
  it('drops fonts, sizes, colours, classes and style blocks but keeps structure', () => {
    const html =
      '<meta charset="utf-8"><style>p{color:red}</style>' +
      '<p class="x" style="font-family:Comic Sans MS;font-size:30px;color:red">Hello <font face="Arial" color="blue">there</font></p>' +
      '<ol start="3"><li><a href="https://example.com" style="color:green">link</a></li></ol>'
    const out = cleanPastedHtml(html)
    expect(out).toBe('<p>Hello there</p><ol start="3"><li><a href="https://example.com">link</a></li></ol>')
  })

  it('keeps bold and italic expressed as inline styles (Google Docs style)', () => {
    const html =
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">bold</span> ' +
      '<span style="font-style:italic">it</span> plain</p></b>'
    expect(cleanPastedHtml(html)).toBe('<p><strong>bold</strong> <em>it</em> plain</p>')
  })
})

describe('stripCopiedStyles', () => {
  it('keeps colour and drops every other inline style, class and data attribute', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p class="a" data-x="1"><span style="color: red; font-family: Mono; font-size: 20px">t</span></p>'
    stripCopiedStyles(root)
    expect(root.innerHTML).toBe('<p><span style="color: red;">t</span></p>')
  })
})

describe('clipboard serializers', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
              { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'styled', marks: [{ type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Comic Sans MS', fontSize: '30px' } }] }],
      },
    ],
  })

  it('serializes a slice to developer-clean plain text', () => {
    expect(serializeSliceAsText(doc.slice(0, doc.content.size))).toBe('1. one\n2. two\n  - a\nstyled')
  })

  it('serializes HTML with semantic lists and colour only', () => {
    const out = makeClipboardSerializer(schema).serializeFragment(doc.content, { document })
    const div = document.createElement('div')
    div.appendChild(out)
    expect(div.querySelector('ol > li')).not.toBeNull()
    expect(div.innerHTML).toContain('color')
    expect(div.innerHTML).not.toContain('font-family')
    expect(div.innerHTML).not.toContain('font-size')
  })
})
