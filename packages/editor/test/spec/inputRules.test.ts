// @product-rule no-auto-formatting (CLAUDE.md, Product rules). A guarded spec: its expectations only
// grow, and only the maintainer changes the rule. The unit-level twin of e2e/spec/formatting.spec.ts
// and autobullets.spec.ts, so the rule is checked before any push (red team G2-1).
// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { buildExtensions } from '../../src/extensions'
import { editorRuleOptions } from '../../src/inputRules'
import { SlateKeymap } from '../../src/keymap'

/** A box editor as BoxEditor builds it (extensions, keymap, rule options), without React or Loro. */
function boxEditor(settings: { markdownShortcuts: boolean; autoBullets: boolean }): Editor {
  return new Editor({ extensions: [...buildExtensions({ autoBullets: settings.autoBullets }), SlateKeymap], ...editorRuleOptions(settings) })
}

/** Types like a person: each key goes to the keymap first, then to the input rules, then into the text. */
function typeInto(editor: Editor, text: string): void {
  for (const ch of text) {
    const view = editor.view
    if (view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key: ch })))) continue
    const { from, to } = view.state.selection
    const insert = () => view.state.tr.insertText(ch, from, to)
    if (view.someProp('handleTextInput', (f) => f(view, from, to, ch, insert))) continue
    view.dispatch(insert())
  }
}

/** The document's block types and its text, after typing `text` into an empty box. */
function typed(text: string, settings = { markdownShortcuts: false, autoBullets: true }): { blocks: string[]; text: string; marks: number } {
  const editor = boxEditor(settings)
  try {
    typeInto(editor, text)
    const blocks: string[] = []
    let marks = 0
    editor.state.doc.descendants((node) => {
      if (node.isBlock) blocks.push(node.type.name)
      marks += node.marks.length
    })
    return { blocks, text: editor.state.doc.textContent, marks }
  } finally {
    editor.destroy()
  }
}

describe('no auto-formatting by default, typed (red team final F-2)', () => {
  const MARKDOWN = ['# heading', '## heading', '> quote', '- dash', '+ plus', '```js ', '``` ', '1. one', '1) one', '[ ] task', '**bold** ', '*em* ', '`code` ', '~~gone~~ ', '---', '___ ']
  it('markdown-like text stays plain text in a paragraph', () => {
    for (const text of MARKDOWN) {
      expect(typed(text), text).toEqual({ blocks: ['paragraph'], text, marks: 0 })
    }
  })

  it('straight quotes, dashes and ellipses are not replaced', () => {
    for (const text of ['"quoted" it\'s', 'a -- b', 'wait...', '(c) (tm) 1/2 ->']) {
      expect(typed(text), text).toEqual({ blocks: ['paragraph'], text, marks: 0 })
    }
  })

  it('the one exception: `* ` at the start of a paragraph becomes a bullet list, and only with autoBullets on', () => {
    expect(typed('* item').blocks).toEqual(['bulletList', 'listItem', 'paragraph'])
    expect(typed('* item').text).toBe('item')
    expect(typed('* item', { markdownShortcuts: false, autoBullets: false })).toEqual({ blocks: ['paragraph'], text: '* item', marks: 0 })
    expect(typed('x * item').blocks).toEqual(['paragraph'])
  })

  it('with autoBullets off, nothing at all is formatted', () => {
    for (const text of [...MARKDOWN, '* star']) {
      expect(typed(text, { markdownShortcuts: false, autoBullets: false }), text).toEqual({ blocks: ['paragraph'], text, marks: 0 })
    }
  })

  it('Markdown Shortcuts on does format (so the typing above really exercises the rules)', () => {
    expect(typed('# heading', { markdownShortcuts: true, autoBullets: true }).blocks).toEqual(['heading'])
    expect(typed('> quote', { markdownShortcuts: true, autoBullets: true }).blocks).toContain('blockquote')
  })
})

describe('no auto-formatting by default', () => {
  it('by default only the `* ` bullet rule runs: no heading, list, quote or code shortcuts', () => {
    expect(editorRuleOptions({ markdownShortcuts: false, autoBullets: true }).enableInputRules).toEqual(['autoBullets'])
  })

  it('with autoBullets off, no input rule runs at all', () => {
    expect(editorRuleOptions({ markdownShortcuts: false, autoBullets: false }).enableInputRules).toBe(false)
  })

  it('the Markdown Shortcuts setting is the only way to turn every input rule on', () => {
    expect(editorRuleOptions({ markdownShortcuts: true, autoBullets: false }).enableInputRules).toBe(true)
    expect(editorRuleOptions({ markdownShortcuts: true, autoBullets: true }).enableInputRules).toBe(true)
  })

  it('paste rules never run: a pasted URL or `**x**` is not reformatted', () => {
    for (const markdownShortcuts of [false, true]) for (const autoBullets of [false, true]) {
      expect(editorRuleOptions({ markdownShortcuts, autoBullets }).enablePasteRules).toBe(false)
    }
  })

  it('no smart quotes, typography or autocorrect extension is loaded; autoBullets is switchable', () => {
    const names = (opts: { autoBullets?: boolean }) => buildExtensions(opts).map((e) => e.name.toLowerCase())
    for (const banned of ['typography', 'smartquotes', 'autocorrect', 'autocapitalize']) expect(names({}), banned).not.toContain(banned)
    expect(names({ autoBullets: true })).toContain('autobullets')
    expect(names({ autoBullets: false })).not.toContain('autobullets')
  })
})
