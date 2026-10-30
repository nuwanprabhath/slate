// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { buildExtensions, copyFormat } from '../src/extensions'
import { FormatPainter, formatPainter } from '../src/formatPainter'

/** Phase 15 WP-C2: the format painter copies marks and block format from one selection to the next. */
let editor: Editor | null = null
afterEach(() => {
  formatPainter.stop()
  editor?.destroy()
  editor = null
})

function open(content: string): Editor {
  editor = new Editor({ extensions: [...buildExtensions(), FormatPainter], content })
  return editor
}

/** Selects the first occurrence of `text`. */
function select(ed: Editor, text: string): void {
  let found = -1
  ed.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text)
    return found < 0
  })
  ed.commands.setTextSelection({ from: found, to: found + text.length })
}

const blockOf = (ed: Editor, text: string) => {
  let out: Record<string, unknown> = {}
  ed.state.doc.descendants((node) => {
    if (node.isTextblock && node.textContent.includes(text)) out = { type: node.type.name, ...node.attrs }
    return !node.isTextblock
  })
  return out
}
const marksOf = (ed: Editor, text: string) => {
  const out: string[] = []
  ed.state.doc.descendants((node) => {
    if (node.isText && node.text!.includes(text)) for (const m of node.marks) out.push(m.attrs && Object.values(m.attrs).some((v) => v !== null) ? `${m.type.name}${JSON.stringify(m.attrs)}` : m.type.name)
  })
  return out.sort()
}

describe('copyFormat / pasteFormat', () => {
  it('carries bold, italic, colour, font, size and sub/superscript, and clears marks the source lacks', () => {
    const ed = open('<p><strong><em><span style="color: #ff0000; font-size: 18px; font-family: Georgia, serif">src</span></em></strong> <u><s>dst</s></u> <sub>low</sub></p>')
    select(ed, 'src')
    const red = copyFormat(ed.state)
    select(ed, 'dst')
    ed.commands.pasteFormat(red)
    expect(marksOf(ed, 'dst')).toEqual(marksOf(ed, 'src'))
    expect(marksOf(ed, 'dst').join()).toContain('"color":"#ff0000"')
    select(ed, 'low')
    const sub = copyFormat(ed.state)
    select(ed, 'src')
    ed.commands.pasteFormat(sub)
    expect(marksOf(ed, 'src')).toEqual(marksOf(ed, 'low'))
    expect(marksOf(ed, 'src').join()).toContain('"verticalAlign":"sub"')
  })

  it('keeps a link on the target: a link is not formatting', () => {
    const ed = open('<p><strong>src</strong> <a href="https://example.com">dst</a></p>')
    select(ed, 'src')
    const f = copyFormat(ed.state)
    select(ed, 'dst')
    ed.commands.pasteFormat(f)
    expect(marksOf(ed, 'dst').map((m) => m.split('{')[0])).toEqual(['bold', 'link'])
  })

  it('carries the block: heading level, alignment and indent', () => {
    const ed = open('<h2 style="text-align: center; margin-left: 24px">src</h2><p>dst</p>')
    select(ed, 'src')
    const f = copyFormat(ed.state)
    select(ed, 'dst')
    ed.commands.pasteFormat(f)
    expect(blockOf(ed, 'dst')).toMatchObject({ type: 'heading', level: 2, textAlign: 'center', indent: 1 })
  })

  it('a plain paragraph source turns a heading back into a paragraph with no alignment or indent', () => {
    const ed = open('<p>src</p><h1 style="text-align: right; margin-left: 48px">dst</h1>')
    select(ed, 'src')
    const f = copyFormat(ed.state)
    select(ed, 'dst')
    ed.commands.pasteFormat(f)
    expect(blockOf(ed, 'dst')).toMatchObject({ type: 'paragraph', textAlign: null, indent: null })
  })

  it('carries a to-do item, a bulleted item and a plain paragraph between each other', () => {
    const ed = open('<ul><li data-checked="true"><p>todo</p></li></ul><p>plain</p><p>gap</p><ul><li><p>bullet</p></li></ul>')
    const formatOf = (text: string) => {
      select(ed, text)
      return copyFormat(ed.state)
    }
    const [todo, plain, bullet] = [formatOf('todo'), formatOf('plain'), formatOf('bullet')]
    expect([todo.list, plain.list, bullet.list]).toEqual(['todo', 'none', 'bullet'])
    ed.commands.pasteFormat(todo) // onto "bullet"
    expect(formatOf('bullet').list).toBe('todo')
    ed.commands.pasteFormat(bullet) // and back
    expect(formatOf('bullet').list).toBe('bullet')
    select(ed, 'plain')
    ed.commands.pasteFormat(todo)
    expect(formatOf('plain').list).toBe('todo')
    ed.commands.pasteFormat(plain)
    expect(blockOf(ed, 'plain')).toMatchObject({ type: 'paragraph' })
    expect(formatOf('plain').list).toBe('none')
    expect(formatOf('todo').list).toBe('todo')
  })
})

describe('the painter', () => {
  it('a click paints the next text selection once, then turns off', async () => {
    const ed = open('<p><strong>src</strong> dst other</p>')
    select(ed, 'src')
    formatPainter.start(ed, false)
    expect(formatPainter.get()?.sticky).toBe(false)
    expect(document.documentElement.dataset.formatPainter).toBe('on')
    ed.commands.setTextSelection(8) // a click with no selection paints nothing
    ed.view.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(formatPainter.get()).not.toBeNull()
    select(ed, 'dst')
    ed.view.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(marksOf(ed, 'dst')).toEqual(['bold'])
    expect(formatPainter.get()).toBeNull()
    expect(document.documentElement.dataset.formatPainter).toBeUndefined()
    select(ed, 'other')
    ed.view.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(marksOf(ed, 'other')).toEqual([])
  })

  it('sticky (double-click) stays on until Escape', async () => {
    const ed = open('<p><em>src</em> one two</p>')
    select(ed, 'src')
    formatPainter.start(ed, true)
    for (const word of ['one', 'two']) {
      select(ed, word)
      ed.view.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
      expect(marksOf(ed, word)).toEqual(['italic'])
    }
    expect(formatPainter.get()?.sticky).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(formatPainter.get()).toBeNull()
  })

  it('typing never paints: only a selection made after starting it', () => {
    const ed = open('<p><strong>src</strong> dst</p>')
    select(ed, 'src')
    formatPainter.start(ed, false)
    ed.commands.insertContentAt(ed.state.doc.content.size - 1, 'typed')
    expect(marksOf(ed, 'typed')).toEqual([])
  })
})
