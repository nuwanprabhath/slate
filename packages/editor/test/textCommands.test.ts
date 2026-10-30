// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { buildExtensions } from '../src/extensions'
import { copyWithImages } from '../src/images'
import { copyAsMarkdown, copyMarkdownInto } from '../src/textCommands'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy())
  Reflect.deleteProperty(document, 'execCommand')
})

const IMG = 'slate-blob://blob/aaaa.png'

/** A box editor's copy handling: Copy as Markdown first, then the copy with images, as BoxEditor wires them. */
function make(html: string, rich: string[] = []): Editor {
  const services = { copyImage: async () => true, copyRich: async (text: string) => void rich.push(text) }
  const editor = new Editor({
    extensions: buildExtensions(),
    content: html,
    editorProps: { handleDOMEvents: { copy: (view, event) => copyMarkdownInto(view, event) || copyWithImages(view, event, services) } },
  })
  editors.push(editor)
  return editor
}

function select(editor: Editor, from: number, to: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
}

/** What the browser does for execCommand('copy'): a copy event on the focused editor, with a clipboard to fill. */
function fakeClipboard(editor: Editor) {
  const data = new Map<string, string>()
  const events: Event[] = []
  // happy-dom has no execCommand; the browser's runs the copy synchronously, as this does.
  const execCommand = vi.fn((command: string) => {
    if (command !== 'copy') return false
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (t: string, v: string) => void data.set(t, v), clearData: () => data.clear(), getData: (t: string) => data.get(t) ?? '' },
    })
    events.push(event)
    editor.view.dom.dispatchEvent(event)
    return true
  })
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
  return { data, events }
}

describe('copyAsMarkdown', () => {
  it('copies the selection as Markdown, text/plain only, through a copy event', () => {
    const editor = make('<h2>Plan</h2><ul><li><p><strong>ship</strong> it</p></li></ul>')
    select(editor, 1, editor.state.doc.content.size - 1)
    const { data, events } = fakeClipboard(editor)
    expect(copyAsMarkdown(editor.view)).toBe(true)
    expect([...data]).toEqual([['text/plain', '## Plan\n\n- **ship** it']])
    expect(events[0]!.defaultPrevented).toBe(true)
  })

  it('keeps images as their note address instead of handing them to the picture copy', () => {
    const rich: string[] = []
    const editor = make(`<p>See</p><img src="${IMG}"><p>below</p>`, rich)
    select(editor, 1, editor.state.doc.content.size - 1)
    const { data } = fakeClipboard(editor)
    copyAsMarkdown(editor.view)
    expect(data.get('text/plain')).toBe(`See\n\n![](${IMG})\n\nbelow`)
    expect(rich).toEqual([])
  })

  it('does nothing without a selection', () => {
    const editor = make('<p>text</p>')
    select(editor, 2, 2)
    const { events } = fakeClipboard(editor)
    expect(copyAsMarkdown(editor.view)).toBe(false)
    expect(events).toEqual([])
  })

  it('leaves an ordinary copy to the editor', () => {
    const editor = make('<p><strong>bold</strong></p>')
    select(editor, 1, 5)
    const event = new Event('copy', { cancelable: true }) as ClipboardEvent
    expect(copyMarkdownInto(editor.view, event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })
})
