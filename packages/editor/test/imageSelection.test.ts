// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { buildExtensions } from '../src/extensions'
import { ImageSelection } from '../src/imageSelection'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))

function make(): Editor {
  const editor = new Editor({
    extensions: [...buildExtensions(), ImageSelection],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'image', attrs: { src: PNG } },
        { type: 'paragraph' },
        { type: 'image', attrs: { src: PNG } },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    },
  })
  editors.push(editor)
  return editor
}

const marked = (editor: Editor) => Array.from(editor.view.dom.querySelectorAll('img')).map((img) => img.classList.contains('slate-image-selected'))

describe('ImageSelection', () => {
  it('marks an image inside a text selection, which the browser does not highlight (contenteditable=false)', () => {
    const editor = make()
    // From after "a" to the empty line below the first image: a shift+click across it.
    const { tr, doc } = editor.state
    editor.view.dispatch(tr.setSelection(TextSelection.create(doc, 2, 5)))
    expect(marked(editor)).toEqual([true, false])
  })

  it('marks every image under select all and none for a caret', () => {
    const editor = make()
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    expect(marked(editor)).toEqual([true, true])
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
    expect(marked(editor)).toEqual([false, false])
  })

  it('leaves a clicked image to its node selection outline', () => {
    const editor = make()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 3)))
    expect(marked(editor)).toEqual([false, false])
    expect(editor.view.dom.querySelectorAll('img.ProseMirror-selectednode')).toHaveLength(1)
  })
})
