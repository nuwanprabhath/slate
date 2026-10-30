// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/extensions'
import { editorRuleOptions } from '../src/inputRules'
import { findUrls, linkedTextBlocks, pastePlain, PastedLinks } from '../src/links'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))

function make(enabled = true): Editor {
  // As the box editor: TipTap's own paste rules (the Link extension has one) are off.
  const editor = new Editor({ extensions: [...buildExtensions(), PastedLinks.configure({ enabled })], ...editorRuleOptions({ markdownShortcuts: false, autoBullets: true }), content: '<p></p>' })
  editors.push(editor)
  return editor
}

/** The doc's text runs with the href each carries, so a test reads what is linked at a glance. */
function runs(editor: Editor): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = []
  editor.state.doc.descendants((node) => {
    if (node.isText) out.push([node.text!, (node.marks.find((m) => m.type.name === 'link')?.attrs.href as string | undefined) ?? null])
  })
  return out
}

describe('findUrls', () => {
  const urls = (text: string) => findUrls(text).map((u) => [text.slice(u.from, u.to), u.href])

  it('finds http, https, mailto and www. addresses in text', () => {
    expect(urls('see https://github.com/a?b=1#c and http://x.io')).toEqual([
      ['https://github.com/a?b=1#c', 'https://github.com/a?b=1#c'],
      ['http://x.io', 'http://x.io'],
    ])
    expect(urls('mail mailto:me@a.io now')).toEqual([['mailto:me@a.io', 'mailto:me@a.io']])
    expect(urls('www.example.com/docs')).toEqual([['www.example.com/docs', 'https://www.example.com/docs']])
  })

  it('leaves out the punctuation that ends a sentence or wraps the address', () => {
    expect(urls('Go to https://a.io/x.')).toEqual([['https://a.io/x', 'https://a.io/x']])
    expect(urls('(see https://a.io/x)')).toEqual([['https://a.io/x', 'https://a.io/x']])
    expect(urls('"https://a.io/x",')).toEqual([['https://a.io/x', 'https://a.io/x']])
    expect(urls('https://en.wikipedia.org/wiki/Slate_(rock)')).toEqual([['https://en.wikipedia.org/wiki/Slate_(rock)', 'https://en.wikipedia.org/wiki/Slate_(rock)']])
  })

  it('never links a script-bearing scheme, a bare scheme or a word that only contains one', () => {
    expect(urls('javascript:alert(1) data:text/html,x vbscript:x')).toEqual([])
    expect(urls('https:// and mailto: alone')).toEqual([])
    expect(urls('xhttps://a.io')).toEqual([])
    expect(urls('a.www.example.com')).toEqual([])
  })
})

describe('linkedTextBlocks', () => {
  it('makes one paragraph per line with the addresses linked', () => {
    expect(linkedTextBlocks('a https://a.io\n\nb', true)).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a ' }, { type: 'text', text: 'https://a.io', marks: [{ type: 'link', attrs: { href: 'https://a.io' } }] }] },
      { type: 'paragraph', content: [] },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
    ])
    expect(linkedTextBlocks('https://a.io', false)).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'https://a.io' }] }])
  })
})

describe('PastedLinks', () => {
  it('links an address pasted as text or inside pasted HTML', () => {
    const editor = make()
    editor.view.pasteText('https://github.com/nuwanprabhath/slate')
    expect(runs(editor)).toEqual([['https://github.com/nuwanprabhath/slate', 'https://github.com/nuwanprabhath/slate']])

    const html = make()
    html.view.pasteHTML('<p>Docs at <b>https://a.io/docs</b>, done</p>')
    expect(runs(html)).toEqual([
      ['Docs at ', null],
      ['https://a.io/docs', 'https://a.io/docs'],
      [', done', null],
    ])
  })

  it('keeps an existing link, and code, as they are', () => {
    const editor = make()
    editor.view.pasteHTML('<p><a href="https://b.io">https://a.io</a> <code>https://c.io</code></p>')
    expect(runs(editor)).toEqual([
      ['https://a.io', 'https://b.io'],
      [' ', null],
      ['https://c.io', null],
    ])
  })

  it('leaves addresses as text with the setting off, and for paste as plain text', () => {
    const off = make(false)
    off.view.pasteText('https://a.io')
    expect(runs(off)).toEqual([['https://a.io', null]])

    const plain = make()
    pastePlain(plain.view, 'https://a.io')
    expect(runs(plain)).toEqual([['https://a.io', null]])
    plain.view.pasteText(' https://b.io')
    expect(runs(plain)).toEqual([
      ['https://a.io ', null],
      ['https://b.io', 'https://b.io'],
    ])
  })
})
