// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanPastedHtml, makeClipboardSerializer, serializeSliceAsText } from '../src/clipboard'
import { buildExtensions, schema } from '../src/extensions'
import { editorRuleOptions } from '../src/inputRules'
import { SlateKeymap } from '../src/keymap'

/** Phase 15 WP-C1: to-do lists, alignment, sub- and superscript. */
let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function open(content: string, settings = { markdownShortcuts: false, autoBullets: true }): Editor {
  editor = new Editor({ extensions: [...buildExtensions({ autoBullets: settings.autoBullets }), SlateKeymap], content, ...editorRuleOptions(settings) })
  return editor
}

const isMac = /mac/i.test(navigator.platform)
const KEY_CODES: Record<string, number> = { '9': 57, ',': 188, '.': 190, l: 76, e: 69, r: 82, Tab: 9, Enter: 13 }

/** Presses a shortcut such as `Mod-Shift-9` through the editor's keymaps. */
function press(ed: Editor, shortcut: string): boolean {
  const parts = shortcut.split('-')
  const key = parts.pop()!
  const mod = parts.includes('Mod')
  const event = new KeyboardEvent('keydown', {
    key,
    keyCode: KEY_CODES[key] ?? 0,
    metaKey: mod && isMac,
    ctrlKey: mod && !isMac,
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, 'keyCode', { value: KEY_CODES[key] ?? 0 })
  const view = ed.view
  return view.someProp('handleKeyDown', (f) => f(view, event)) ?? false
}

const json = (ed: Editor) => JSON.stringify(ed.getJSON())
const items = (ed: Editor) => {
  const out: Array<boolean | null> = []
  ed.state.doc.descendants((n) => {
    if (n.type.name === 'listItem') out.push(n.attrs.checked as boolean | null)
  })
  return out
}

describe('to-do list', () => {
  it('the command turns a paragraph into a to-do item in a bulleted list, and back', () => {
    const ed = open('<p>milk</p>')
    ed.commands.toggleTodoList()
    expect(ed.getJSON().content?.[0]?.type).toBe('bulletList')
    expect(items(ed)).toEqual([false])
    expect(ed.isActive('listItem', { checked: false })).toBe(true)
    ed.commands.toggleTodoList()
    expect(json(ed)).toBe(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: null, indent: null }, content: [{ type: 'text', text: 'milk' }] }] }))
  })

  it('inside a bulleted or numbered list, the whole list becomes a to-do list', () => {
    const bullets = open('<ul><li><p>a</p></li><li><p>b</p></li></ul>')
    bullets.commands.setTextSelection(3)
    bullets.commands.toggleTodoList()
    expect(items(bullets)).toEqual([false, false])
    bullets.destroy()
    const numbered = open('<ol><li><p>a</p></li><li><p>b</p></li></ol>')
    numbered.commands.setTextSelection(3)
    numbered.commands.toggleTodoList()
    expect(numbered.getJSON().content?.[0]?.type).toBe('bulletList')
    expect(items(numbered)).toEqual([false, false])
  })

  it('Mod+Shift+9 toggles it', () => {
    const ed = open('<p>milk</p>')
    expect(press(ed, 'Mod-Shift-9')).toBe(true)
    expect(items(ed)).toEqual([false])
  })

  it('clicking the box ticks and unticks the item', () => {
    const ed = open('<ul><li data-checked="false"><p>milk</p></li></ul>')
    const li = () => ed.view.dom.querySelector('li')!
    expect(li().getAttribute('data-checked')).toBe('false')
    li().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    expect(items(ed)).toEqual([true])
    expect(li().getAttribute('data-checked')).toBe('true')
    li().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    expect(items(ed)).toEqual([false])
  })

  it('a click in the item text does not tick it', () => {
    const ed = open('<ul><li data-checked="false"><p>milk</p></li></ul>')
    ed.view.dom.querySelector('li p')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    expect(items(ed)).toEqual([false])
  })

  it('Enter after a ticked item starts an unticked one; Tab nests it as a to-do and Shift+Tab brings it back', () => {
    const ed = open('<ul><li data-checked="true"><p>milk</p></li></ul>')
    ed.commands.setTextSelection(7)
    expect(press(ed, 'Enter')).toBe(true)
    expect(items(ed)).toEqual([true, false])
    ed.commands.insertContent('eggs')
    expect(press(ed, 'Tab')).toBe(true)
    const outer = ed.getJSON().content?.[0]?.content ?? []
    expect(outer).toHaveLength(1)
    expect(JSON.stringify(outer[0])).toContain('"checked":false')
    expect(items(ed)).toEqual([true, false])
    expect(press(ed, 'Shift-Tab')).toBe(true)
    expect(ed.getJSON().content?.[0]?.content).toHaveLength(2)
  })

  it('is never made by typing `[ ] `, even with Markdown Shortcuts on', () => {
    for (const markdownShortcuts of [false, true]) {
      const ed = open('<p></p>', { markdownShortcuts, autoBullets: true })
      for (const ch of '[ ] task') {
        const { from, to } = ed.state.selection
        const insert = () => ed.state.tr.insertText(ch, from, to)
        if (!ed.view.someProp('handleTextInput', (f) => f(ed.view, from, to, ch, insert))) ed.view.dispatch(insert())
      }
      expect(items(ed), String(markdownShortcuts)).toEqual([])
      expect(ed.getText()).toBe('[ ] task')
      ed.destroy()
    }
  })

  it('copies as `- [ ]`/`- [x]` text and as task-list HTML with disabled checkboxes', () => {
    const ed = open('<ul><li data-checked="false"><p>milk</p></li><li data-checked="true"><p>eggs</p></li></ul>')
    const slice = ed.state.doc.slice(0, ed.state.doc.content.size)
    expect(serializeSliceAsText(slice)).toBe('- [ ] milk\n- [x] eggs')
    const div = document.createElement('div')
    div.appendChild(makeClipboardSerializer(schema).serializeFragment(slice.content, { document }))
    expect(div.querySelector('ul')!.getAttribute('data-type')).toBe('taskList')
    const boxes = Array.from(div.querySelectorAll('li > input[type="checkbox"]')) as HTMLInputElement[]
    expect(boxes.map((b) => [b.hasAttribute('checked'), b.hasAttribute('disabled')])).toEqual([
      [false, true],
      [true, true],
    ])
    expect(div.querySelector('li')!.hasAttribute('data-checked')).toBe(false)
  })

  it('pasting a copied to-do list (or a GitHub task list) keeps the boxes and ticks', () => {
    const html = '<ul data-type="taskList"><li><input type="checkbox" disabled><p>milk</p></li><li class="task-list-item"><input class="x" type="checkbox" checked disabled> eggs</li></ul>'
    const ed = open(cleanPastedHtml(html))
    expect(items(ed)).toEqual([false, true])
    expect(ed.getText()).toContain('milk')
    expect(ed.getText()).toContain('eggs')
  })
})

describe('alignment', () => {
  it('centres and right-aligns paragraphs and headings, and left alignment clears it', () => {
    const ed = open('<h2>Title</h2><p>body</p>')
    ed.commands.selectAll()
    ed.commands.setTextAlign('center')
    expect(ed.getHTML()).toBe('<h2 style="text-align: center;">Title</h2><p style="text-align: center;">body</p>')
    ed.commands.setTextAlign('right')
    expect(ed.isActive({ textAlign: 'right' })).toBe(true)
    ed.commands.setTextAlign('left')
    expect(ed.getHTML()).toBe('<h2>Title</h2><p>body</p>')
  })

  it('Mod+Shift+E centres, Mod+Shift+R right-aligns, Mod+Alt+Shift+L left-aligns', () => {
    const ed = open('<p>body</p>')
    ed.commands.setTextSelection(2)
    expect(press(ed, 'Mod-Shift-e')).toBe(true)
    expect(ed.state.doc.firstChild?.attrs.textAlign).toBe('center')
    expect(press(ed, 'Mod-Shift-r')).toBe(true)
    expect(ed.state.doc.firstChild?.attrs.textAlign).toBe('right')
    expect(press(ed, 'Mod-Alt-Shift-l')).toBe(true)
    expect(ed.state.doc.firstChild?.attrs.textAlign).toBeNull()
  })

  it('copied HTML keeps text-align (and colour) and nothing else; paste keeps it too', () => {
    const ed = open('<p style="text-align: right; font-size: 30px">r</p>')
    const div = document.createElement('div')
    div.appendChild(makeClipboardSerializer(schema).serializeFragment(ed.state.doc.content, { document }))
    expect(div.innerHTML).toBe('<p style="text-align: right;">r</p>')
    expect(cleanPastedHtml('<p style="text-align:center;font-size:30px;color:red">c</p><p style="text-align: justify">j</p>')).toBe('<p style="text-align: center;">c</p><p>j</p>')
  })
})

describe('subscript and superscript', () => {
  it('are exclusive of each other, render as <sub>/<sup>, and toggle off', () => {
    const ed = open('<p>H2O</p>')
    ed.commands.setTextSelection({ from: 2, to: 3 })
    ed.commands.toggleSubscript()
    expect(ed.getHTML()).toBe('<p>H<sub>2</sub>O</p>')
    expect(ed.isActive('textStyle', { verticalAlign: 'sub' })).toBe(true)
    ed.commands.toggleSuperscript()
    expect(ed.getHTML()).toBe('<p>H<sup>2</sup>O</p>')
    ed.commands.toggleSuperscript()
    expect(ed.getHTML()).toBe('<p>H2O</p>')
    expect(JSON.stringify(ed.getJSON())).not.toContain('textStyle')
  })

  it('Mod+Shift+, and Mod+Shift+. toggle them', () => {
    const ed = open('<p>x2</p>')
    ed.commands.setTextSelection({ from: 2, to: 3 })
    expect(press(ed, 'Mod-Shift-,')).toBe(true)
    expect(ed.getHTML()).toBe('<p>x<sub>2</sub></p>')
    expect(press(ed, 'Mod-Shift-.')).toBe(true)
    expect(ed.getHTML()).toBe('<p>x<sup>2</sup></p>')
  })

  it('keeps colour alongside, parses pasted <sub>/<sup>, and copies as <sub>/<sup>', () => {
    const ed = open(cleanPastedHtml('<p>H<sub>2</sub>O e=mc<sup>2</sup></p>'))
    ed.commands.selectAll()
    ed.commands.setColor('#ff0000')
    const div = document.createElement('div')
    div.appendChild(makeClipboardSerializer(schema).serializeFragment(ed.state.doc.content, { document }))
    expect(div.querySelector('sub')?.textContent).toBe('2')
    expect(div.querySelector('sup')?.textContent).toBe('2')
    expect(div.querySelector('sub')?.style.color).not.toBe('')
    expect(serializeSliceAsText(ed.state.doc.slice(0, ed.state.doc.content.size))).toBe('H2O e=mc2')
  })
})
