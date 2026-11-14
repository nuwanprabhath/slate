// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/extensions'
import { isLinkHref, isSingleUrl, normalizeLinkInput } from '../src/links'
import { LoroDoc } from 'loro-crdt'
import { writeContent } from '../src/content'
import { schema } from '../src/extensions'
import { renderStaticHtml } from '../src/staticRender'

describe('normalizeLinkInput', () => {
  it('adds https:// to a bare domain or path', () => {
    expect(normalizeLinkInput('  example.com ')).toEqual({ href: 'https://example.com' })
    expect(normalizeLinkInput('example.com/a?b=1')).toEqual({ href: 'https://example.com/a?b=1' })
    expect(normalizeLinkInput('www.example.com')).toEqual({ href: 'https://www.example.com' })
  })
  it('keeps http, https and mailto as typed', () => {
    expect(normalizeLinkInput('http://a.io')).toEqual({ href: 'http://a.io' })
    expect(normalizeLinkInput('https://a.io/x')).toEqual({ href: 'https://a.io/x' })
    expect(normalizeLinkInput('mailto:me@a.io')).toEqual({ href: 'mailto:me@a.io' })
  })
  it('rejects script-bearing schemes in any case', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', ' java\tscript:alert(1)']) {
      expect(normalizeLinkInput(bad)).toHaveProperty('error')
    }
  })
  it('rejects empty input and unknown schemes', () => {
    expect(normalizeLinkInput('   ')).toHaveProperty('error')
    expect(normalizeLinkInput('ftp://a.io')).toHaveProperty('error')
  })
})

describe('isLinkHref', () => {
  it('keeps the schemes a link may use', () => {
    for (const ok of ['http://a.io', 'https://a.io/x', 'mailto:me@a.io', 'HTTPS://a.io']) expect(isLinkHref(ok)).toBe(true)
  })
  it('keeps an address with no scheme at all', () => {
    // Nothing Slate writes is relative, but a pasted page's "/a" or "#x" cannot name a program, and
    // hardening refuses navigation off app://slate/ anyway.
    for (const ok of ['/a/b', '#x', '?q=1', 'example.com:8080/x']) expect(isLinkHref(ok)).toBe(true)
  })
  it('refuses a scheme that carries a digit (FX-50)', () => {
    // TipTap's own isAllowedUri reads "letters then a non-letter" as a relative path, so a digit anywhere
    // in the scheme defeated it: these all passed before this check existed.
    for (const bad of ['l1ra:', 'web3:pay', 's3://b/k', 'h323:x', 'x1:evil', 'jav1ascript:alert(1)', 'data1:text/html,x'])
      expect(isLinkHref(bad), bad).toBe(false)
  })
  it('refuses the script-bearing and program-launching schemes', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', ' java\tscript:alert(1)', 'file:///etc/passwd', 'ftp://a.io'])
      expect(isLinkHref(bad), bad).toBe(false)
  })
})

describe('a link mark never reaches the page with an unsanctioned scheme (FX-50)', () => {
  /** The off-screen path: a content map a peer or an agent wrote, drawn without an editor. */
  const renderHref = (href: string): string | null => {
    const doc = new LoroDoc()
    const root = doc.getMap('content')
    try {
      writeContent(root, [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] }], doc)
      doc.commit()
      const fragment = renderStaticHtml(schema, doc, root.id, document)
      if (!fragment) return null
      const host = document.createElement('div')
      host.append(fragment)
      return host.querySelector('a')?.getAttribute('href') ?? null
    } finally {
      root.free()
      doc.free()
    }
  }

  it('draws a sanctioned href as it is', () => {
    expect(renderHref('https://a.io/x')).toBe('https://a.io/x')
    expect(renderHref('mailto:me@a.io')).toBe('mailto:me@a.io')
  })

  it('does not draw a digit-bearing scheme, which is the nightly counterexample', () => {
    // seed 45, path "28499": the soak drew <a href="l1ra:">.
    for (const bad of ['l1ra:', 'web3:pay', 'h323:x']) expect(renderHref(bad), bad).not.toContain(bad.slice(0, bad.indexOf(':')))
  })
})

describe('isSingleUrl', () => {
  it('accepts one http(s) or mailto URL', () => {
    expect(isSingleUrl('https://github.com')).toBe(true)
    expect(isSingleUrl('http://a.io/x?y=1#z')).toBe(true)
    expect(isSingleUrl('mailto:me@a.io')).toBe(true)
    expect(isSingleUrl('  https://github.com\n')).toBe(true)
  })
  it('rejects text, spaces, several lines and other schemes', () => {
    expect(isSingleUrl('github.com')).toBe(false)
    expect(isSingleUrl('see https://github.com')).toBe(false)
    expect(isSingleUrl('https://a.io\nhttps://b.io')).toBe(false)
    expect(isSingleUrl('javascript:alert(1)')).toBe(false)
    expect(isSingleUrl('')).toBe(false)
  })
})

function typeText(editor: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp('handleTextInput', (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)))
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to))
  }
}

function make(opts: { autoBullets?: boolean; markdownShortcuts?: boolean }): Editor {
  const { autoBullets = true, markdownShortcuts = false } = opts
  return new Editor({
    extensions: buildExtensions({ autoBullets }),
    enableInputRules: markdownShortcuts ? true : autoBullets ? ['autoBullets'] : false,
    content: '<p></p>',
  })
}

describe('"* " bullet rule', () => {
  it('turns a paragraph starting with "* " into a bullet item', () => {
    const editor = make({})
    typeText(editor, '* hello')
    expect(editor.getHTML()).toBe('<ul><li><p>hello</p></li></ul>')
  })
  it('is reverted by Backspace right after', () => {
    const editor = make({})
    typeText(editor, '* ')
    expect(editor.commands.undoInputRule()).toBe(true)
    expect(editor.getHTML()).toBe('<p>* </p>')
  })
  it('does nothing when the setting is off', () => {
    const editor = make({ autoBullets: false })
    typeText(editor, '* hello')
    expect(editor.getHTML()).toBe('<p>* hello</p>')
  })
  it('does nothing mid-line or inside a list', () => {
    const editor = make({})
    typeText(editor, 'a * b')
    expect(editor.getHTML()).toBe('<p>a * b</p>')
    const inList = make({})
    typeText(inList, '* ')
    typeText(inList, '* x')
    expect(inList.getHTML()).toBe('<ul><li><p>* x</p></li></ul>')
  })
  it('leaves "- " alone while Markdown Shortcuts is off', () => {
    const editor = make({})
    typeText(editor, '- hi')
    expect(editor.getHTML()).toBe('<p>- hi</p>')
  })
})
