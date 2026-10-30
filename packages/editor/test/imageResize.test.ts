// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { cleanPastedHtml, makeClipboardSerializer } from '../src/clipboard'
import { buildExtensions, schema } from '../src/extensions'
import { IMAGE_MIN_WIDTH, ImageResize, resizedWidth, setImageWidth } from '../src/imageResize'
import { LoroBinding } from '../src/loroBinding'
import { PageSession } from '../src/PageSession'
import { writeContent } from '../src/content'

const PNG = 'slate-blob://blob/abc.png'
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))

function make(width: number | null = null): Editor {
  const holder = document.createElement('div')
  document.body.appendChild(holder)
  const editor = new Editor({
    element: holder,
    extensions: [...buildExtensions(), ImageResize],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'image', attrs: { src: PNG, width } },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    },
  })
  editors.push(editor)
  return editor
}

const IMAGE_POS = 3
const handles = () => document.querySelectorAll('.slate-image-handle')

describe('image width attribute', () => {
  it('reads a pixel width from HTML and ignores anything else', () => {
    const editor = new Editor({ extensions: buildExtensions(), content: `<img src="${PNG}" width="240"><img src="${PNG}" width="50%"><img src="${PNG}">` })
    editors.push(editor)
    const widths: unknown[] = []
    editor.state.doc.descendants((n) => void (n.type.name === 'image' && widths.push(n.attrs.width)))
    expect(widths).toEqual([240, null, null])
  })

  it('goes into copied HTML', () => {
    const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'image', attrs: { src: PNG, width: 240 } }] })
    const holder = document.createElement('div')
    holder.appendChild(makeClipboardSerializer(schema).serializeFragment(doc.content))
    expect(holder.querySelector('img')?.getAttribute('width')).toBe('240')
  })

  it('survives a paste, on images only', () => {
    const cleaned = cleanPastedHtml(`<img src="${PNG}" width="240" height="100"><table width="500"><tr><td width="9">x</td></tr></table>`)
    expect(cleaned).toContain('width="240"')
    expect(cleaned).not.toContain('height')
    expect(cleaned).not.toContain('width="500"')
    expect(cleaned).not.toContain('width="9"')
  })
})

describe('resizedWidth', () => {
  const drag = { startWidth: 200, aspect: 2, dx: 0, dy: 0 }

  it('follows the pointer outward from the dragged corner', () => {
    expect(resizedWidth({ ...drag, corner: 'se', dx: 40 }, 1000)).toBe(240)
    expect(resizedWidth({ ...drag, corner: 'ne', dx: -40 }, 1000)).toBe(160)
    expect(resizedWidth({ ...drag, corner: 'nw', dx: -40 }, 1000)).toBe(240)
    expect(resizedWidth({ ...drag, corner: 'sw', dx: 40 }, 1000)).toBe(160)
  })

  it('follows a mostly vertical drag through the aspect ratio', () => {
    expect(resizedWidth({ ...drag, corner: 'se', dx: 2, dy: 30 }, 1000)).toBe(260)
    expect(resizedWidth({ ...drag, corner: 'nw', dx: 0, dy: 30 }, 1000)).toBe(140)
  })

  it('stays between 32px and the box content width', () => {
    expect(resizedWidth({ ...drag, corner: 'se', dx: -500 }, 1000)).toBe(IMAGE_MIN_WIDTH)
    expect(resizedWidth({ ...drag, corner: 'se', dx: 500 }, 300)).toBe(300)
  })

  it('never goes below 32px, even in a box narrower than that (null: no width to store)', () => {
    expect(resizedWidth({ ...drag, corner: 'se', dx: -500 }, 10)).toBeNull()
    expect(resizedWidth({ ...drag, corner: 'se', dx: 500 }, 10)).toBeNull()
    expect(resizedWidth({ ...drag, corner: 'se', dx: -500 }, -4)).toBeNull()
  })
})

describe('setImageWidth', () => {
  it('sets and clears the width in one step, keeping the image selected', () => {
    const editor = make()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, IMAGE_POS)))
    let steps = 0
    editor.on('transaction', ({ transaction }) => void (transaction.docChanged && steps++))
    setImageWidth(editor.view, IMAGE_POS, 240)
    expect(editor.state.doc.nodeAt(IMAGE_POS)?.attrs.width).toBe(240)
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(steps).toBe(1)
    setImageWidth(editor.view, IMAGE_POS, null)
    expect(editor.state.doc.nodeAt(IMAGE_POS)?.attrs.width).toBeNull()
    expect(steps).toBe(2)
  })
})

describe('resizes and undo', () => {
  it('undoes each resize on its own, however quickly they follow each other or typing', async () => {
    const session = await PageSession.open('resize', { load: async () => [], append: async () => {} })
    const boxId = session.createBox(0, 0)
    const box = session.getBoxes().find((b) => b.id === boxId)!
    const root = session.doc.getContainerById(box.contentId) as Parameters<typeof writeContent>[0]
    writeContent(root, [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'image', attrs: { src: PNG } }])
    session.doc.commit()
    const editor = new Editor({
      extensions: [...buildExtensions(), LoroBinding.configure({ doc: session.doc, containerId: box.contentId }), ImageResize.configure({ session })],
    })
    editors.push(editor)
    await new Promise((r) => setTimeout(r, 0))
    editor.commands.insertContentAt(2, 'b')
    setImageWidth(editor.view, IMAGE_POS + 1, 200, session)
    setImageWidth(editor.view, IMAGE_POS + 1, 120, session)
    expect(editor.state.doc.nodeAt(IMAGE_POS + 1)?.attrs.width).toBe(120)
    session.undo()
    expect(editor.state.doc.nodeAt(IMAGE_POS + 1)?.attrs.width).toBe(200)
    session.undo()
    expect(editor.state.doc.nodeAt(IMAGE_POS + 1)?.attrs.width).toBeNull()
    expect(editor.getText()).toContain('ab')
    session.close()
  })
})

describe('ImageResize handles', () => {
  it('shows four corner handles on a clicked image only', () => {
    const editor = make()
    expect(handles()).toHaveLength(0)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, IMAGE_POS)))
    expect(Array.from(handles()).map((h) => h.getAttribute('data-corner'))).toEqual(['nw', 'ne', 'sw', 'se'])
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
    expect(handles()).toHaveLength(0)
  })

  it('shows none when the editor is read-only, and removes them with the editor', () => {
    const editor = make()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, IMAGE_POS)))
    expect(handles()).toHaveLength(4)
    editor.setEditable(false)
    expect(handles()).toHaveLength(0)
    editor.setEditable(true)
    expect(handles()).toHaveLength(4)
    editor.destroy()
    expect(handles()).toHaveLength(0)
  })

  it('resets to natural size on a double-click of a handle', () => {
    const editor = make(240)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, IMAGE_POS)))
    handles()[3]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(editor.state.doc.nodeAt(IMAGE_POS)?.attrs.width).toBeNull()
  })
})
