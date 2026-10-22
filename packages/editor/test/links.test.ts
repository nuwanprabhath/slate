// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/extensions'
import { isSingleUrl, normalizeLinkInput } from '../src/links'

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
    const handled = editor.view.someProp('handleTextInput', (f) => f(editor.view, from, to, ch))
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
