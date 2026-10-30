// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { contentToJSON, writeContent, type PMJSON } from '@slate/core'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanPastedHtml, makeClipboardSerializer, serializeSliceAsText } from '../src/clipboard'
import { buildExtensions, schema } from '../src/extensions'
import { editorRuleOptions } from '../src/inputRules'
import { LoroBinding } from '../src/loroBinding'

/** Phase 15 WP-C2: Tab indents paragraphs and headings; Alt+Shift+Up/Down moves blocks. */
let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function open(content: string | PMJSON): Editor {
  editor = new Editor({ extensions: buildExtensions(), content, ...editorRuleOptions({ markdownShortcuts: false, autoBullets: true }) })
  return editor
}

const KEY_CODES: Record<string, number> = { Tab: 9, ArrowUp: 38, ArrowDown: 40 }

function press(ed: Editor, shortcut: string): boolean {
  const parts = shortcut.split('-')
  const key = parts.pop()!
  const event = new KeyboardEvent('keydown', { key, shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt'), bubbles: true, cancelable: true })
  Object.defineProperty(event, 'keyCode', { value: KEY_CODES[key] ?? 0 })
  const view = ed.view
  return view.someProp('handleKeyDown', (f) => f(view, event)) ?? false
}

/** Puts the caret inside the first text block containing `text`. */
function caretIn(ed: Editor, text: string): void {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent.includes(text)) at = pos + 1
    return at < 0
  })
  ed.commands.setTextSelection(at)
}

const indents = (ed: Editor) => {
  const out: Array<number | null> = []
  ed.state.doc.descendants((n) => {
    if (n.type.name === 'paragraph' || n.type.name === 'heading') out.push(n.attrs.indent as number | null)
  })
  return out
}
const texts = (ed: Editor) => (ed.getJSON().content ?? []).map((b) => JSON.stringify(b).match(/"text":"([^"]*)"/g)?.join('|') ?? '')

describe('Tab indents paragraphs and headings', () => {
  it('Tab and Shift+Tab step a paragraph by one level, never below zero or above eight', () => {
    const ed = open('<p>one</p><p>two</p>')
    caretIn(ed, 'one')
    expect(press(ed, 'Tab')).toBe(true)
    expect(indents(ed)).toEqual([1, null])
    press(ed, 'Tab')
    expect(indents(ed)).toEqual([2, null])
    press(ed, 'Shift-Tab')
    press(ed, 'Shift-Tab')
    expect(indents(ed)).toEqual([null, null])
    expect(press(ed, 'Shift-Tab')).toBe(true)
    expect(indents(ed)).toEqual([null, null])
    for (let i = 0; i < 12; i++) press(ed, 'Tab')
    expect(indents(ed)).toEqual([8, null])
  })

  it('indents every paragraph and heading in the selection, and a heading on its own', () => {
    const ed = open('<h2>title</h2><p>a</p><p>b</p>')
    ed.commands.setTextSelection({ from: 2, to: ed.state.doc.content.size - 1 })
    press(ed, 'Tab')
    expect(indents(ed)).toEqual([1, 1, 1])
  })

  it('draws the indent as a 24px left margin per level and reads it back from HTML', () => {
    const ed = open('<p>x</p>')
    caretIn(ed, 'x')
    press(ed, 'Tab')
    press(ed, 'Tab')
    const p = ed.view.dom.querySelector('p')!
    expect(p.style.marginLeft).toBe('48px')
    const again = open(ed.getHTML())
    expect(indents(again)).toEqual([2])
    expect(indents(open('<p style="margin-left: 72px">x</p>'))).toEqual([3])
    expect(indents(open('<p style="margin-left: 900px">x</p>'))).toEqual([8])
  })

  it('in a list Tab still nests the item, and leaves no indent attribute', () => {
    const ed = open('<ul><li><p>a</p></li><li><p>b</p></li></ul>')
    caretIn(ed, 'b')
    press(ed, 'Tab')
    expect(indents(ed)).toEqual([null, null])
    expect(JSON.stringify(ed.getJSON())).toMatch(/"bulletList".*"bulletList"/)
  })

  it('in the first list item, where nesting is impossible, Tab does not indent the item paragraph', () => {
    const ed = open('<ul><li><p>a</p></li></ul>')
    caretIn(ed, 'a')
    press(ed, 'Tab')
    expect(indents(ed)).toEqual([null])
  })

  it('in a table Tab moves to the next cell and indents nothing', () => {
    const ed = open('<table><tr><td><p>a</p></td><td><p>b</p></td></tr></table>')
    caretIn(ed, 'a')
    press(ed, 'Tab')
    expect(indents(ed)).toEqual([null, null])
    expect(ed.state.selection.$from.parent.textContent).toBe('b')
  })

  it('in a code block Tab does not set an indent', () => {
    const ed = open('<pre><code>x</code></pre>')
    caretIn(ed, 'x')
    press(ed, 'Tab')
    expect(ed.getJSON().content?.[0]?.attrs?.indent).toBeUndefined()
  })

  it('copy keeps the indent: HTML as margin-left, plain text as two spaces per level', () => {
    const ed = open({ type: 'doc', content: [{ type: 'paragraph', attrs: { indent: 2 }, content: [{ type: 'text', text: 'deep' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'flat' }] }] })
    ed.commands.selectAll()
    const slice = ed.state.selection.content()
    const div = document.createElement('div')
    div.appendChild(makeClipboardSerializer(schema).serializeFragment(slice.content))
    expect(div.innerHTML).toContain('<p style="margin-left: 48px;">deep</p>')
    expect(serializeSliceAsText(slice)).toBe('    deep\nflat')
  })

  it('paste keeps a pixel left margin on paragraphs and headings, and drops it elsewhere', () => {
    const out = cleanPastedHtml('<p style="margin-left: 24px; color: red">a</p><div style="margin-left: 24px">b</div><h2 style="margin-left: 2em">c</h2>')
    expect(out).toBe('<p style="margin-left: 24px;">a</p><div>b</div><h2>c</h2>')
  })
})

describe('Alt+Shift+Up/Down moves blocks', () => {
  it('moves the current paragraph up and down one place, keeping the caret in it', () => {
    const ed = open('<p>a</p><p>b</p><p>c</p>')
    caretIn(ed, 'b')
    expect(press(ed, 'Alt-Shift-ArrowUp')).toBe(true)
    expect(texts(ed)).toEqual(['"text":"b"', '"text":"a"', '"text":"c"'])
    expect(ed.state.selection.$from.parent.textContent).toBe('b')
    press(ed, 'Alt-Shift-ArrowDown')
    press(ed, 'Alt-Shift-ArrowDown')
    expect(texts(ed)).toEqual(['"text":"a"', '"text":"c"', '"text":"b"'])
    expect(ed.state.selection.$from.parent.textContent).toBe('b')
  })

  it('does nothing past the first or last block of the box', () => {
    const ed = open('<p>a</p><p>b</p>')
    caretIn(ed, 'a')
    press(ed, 'Alt-Shift-ArrowUp')
    caretIn(ed, 'b')
    press(ed, 'Alt-Shift-ArrowDown')
    expect(texts(ed)).toEqual(['"text":"a"', '"text":"b"'])
  })

  it('moves the selected blocks together', () => {
    const ed = open('<p>a</p><p>b</p><p>c</p><p>d</p>')
    ed.commands.setTextSelection({ from: 4, to: 8 }) // from "b" into "c"
    press(ed, 'Alt-Shift-ArrowDown')
    expect(texts(ed)).toEqual(['"text":"a"', '"text":"d"', '"text":"b"', '"text":"c"'])
    expect(ed.state.selection.empty).toBe(false)
  })

  it('moves a list item with its children among its siblings', () => {
    const ed = open('<ul><li><p>a</p></li><li><p>b</p><ul><li><p>b1</p></li></ul></li><li><p>c</p></li></ul>')
    caretIn(ed, 'b')
    press(ed, 'Alt-Shift-ArrowUp')
    const list = ed.getJSON().content?.[0]
    expect(list?.content?.map((li) => JSON.stringify(li).match(/"text":"(\w+)"/)?.[1])).toEqual(['b', 'a', 'c'])
    expect(JSON.stringify(list?.content?.[0])).toContain('b1')
  })

  it('a move is one undo step', async () => {
    const doc = new LoroDoc()
    const root = doc.getMap('box')
    writeContent(root, [0, 1, 2].map((i) => ({ type: 'paragraph', content: [{ type: 'text', text: `l${i}` }] })), doc)
    doc.commit()
    const undo = new UndoManager(doc, { mergeInterval: 0, excludeOriginPrefixes: ['sys:'] })
    editor = new Editor({ extensions: [...buildExtensions(), LoroBinding.configure({ doc, containerId: root.id })] })
    await new Promise((r) => setTimeout(r, 0))
    caretIn(editor, 'l2')
    press(editor, 'Alt-Shift-ArrowUp')
    doc.commit()
    const order = () => (contentToJSON(root) ?? { content: [] }).content?.map((b) => b.content?.[0]?.text)
    expect(order()).toEqual(['l0', 'l2', 'l1'])
    expect(undo.undo()).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(order()).toEqual(['l0', 'l1', 'l2'])
  })
})
