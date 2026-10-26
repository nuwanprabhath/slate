// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/extensions'

describe('an empty line under the caret', () => {
  it('takes the size and font of the text it will type, so the caret is that tall', () => {
    const editor = new Editor({
      extensions: buildExtensions(),
      content: '<p><span style="font-size: 32px; font-family: monospace">big text</span></p>',
    })
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.splitBlock()
    const lines = editor.view.dom.querySelectorAll('p')
    expect(lines).toHaveLength(2)
    expect((lines[1] as HTMLElement).style.fontSize).toBe('32px')
    expect((lines[1] as HTMLElement).style.fontFamily).toBe('monospace')
    // Not stored: the document still has a bare paragraph.
    expect(editor.getHTML()).toContain('<p></p>')
    editor.destroy()
  })

  it('leaves a line with text alone', () => {
    const editor = new Editor({ extensions: buildExtensions(), content: '<p><span style="font-size: 32px">big</span></p>' })
    editor.commands.setTextSelection(2)
    expect((editor.view.dom.querySelector('p') as HTMLElement).style.fontSize).toBe('')
    editor.destroy()
  })
})
