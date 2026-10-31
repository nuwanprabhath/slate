// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/extensions'
import { cleanPastedHtml, stripCopiedStyles } from '../src/clipboard'
import { floatPosition } from '../src/floatImages'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))
const make = (content: string | object) => {
  const editor = new Editor({ extensions: buildExtensions(), content })
  editors.push(editor)
  return editor
}
const IMG = 'slate-blob://blob/a.png'
const floating = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'text' }] }, { type: 'image', attrs: { src: IMG, x: 120, y: 40 } }] }

describe('a floating picture', () => {
  it('is drawn where it was dropped in its box, and read back from its own drawing', () => {
    const editor = make(floating)
    const html = editor.getHTML()
    expect(html).toContain('position: absolute')
    expect(html).toContain('left: 120px')
    expect(html).toContain('top: 40px')
    const again = make(html)
    expect(again.state.doc.lastChild!.attrs).toMatchObject({ x: 120, y: 40 })
  })

  it('a place out of range (from another device or an agent) is drawn in the text, never far off or outside the box', () => {
    for (const [x, y] of [[-5, 10], [10, 1e9], [Number.NaN, 4], [3, Infinity]]) {
      const doc = { type: 'doc', content: [{ type: 'image', attrs: { src: IMG, x, y } }] }
      expect(make(doc).getHTML()).not.toContain('position')
    }
  })

  it('an unmoved picture stays in the text, with no position', () => {
    const html = make(`<p>text</p><img src="${IMG}">`).getHTML()
    expect(html).not.toContain('position')
    expect(html).not.toContain('data-x')
  })

  it('copies and pastes as a picture in the text: its place in the box is Slate’s own', () => {
    const div = document.createElement('div')
    div.innerHTML = make(floating).getHTML()
    stripCopiedStyles(div)
    expect(div.innerHTML).toBe(`<p>text</p><img src="${IMG}">`)
    const pasted = make(cleanPastedHtml(`<img src="${IMG}" data-x="5" data-y="6" style="position: absolute; left: 5px; top: 6px">`))
    expect(pasted.state.doc.firstChild!.attrs).toMatchObject({ x: null, y: null })
  })
})

describe('floatPosition', () => {
  const area = { left: 100, top: 50, width: 600 }
  it('puts the picture where it was let go, by the point it was held at', () => {
    expect(floatPosition({ x: 400, y: 300 }, { x: 20, y: 10 }, area, 200)).toEqual({ x: 280, y: 240 })
  })

  it('keeps it inside the box sideways and below its top; it may go further down, and the box grows', () => {
    expect(floatPosition({ x: 90, y: 20 }, { x: 20, y: 10 }, area, 200)).toEqual({ x: 0, y: 0 })
    expect(floatPosition({ x: 900, y: 2000 }, { x: 20, y: 10 }, area, 200)).toEqual({ x: 400, y: 1940 })
    expect(floatPosition({ x: 300, y: 300 }, { x: 0, y: 0 }, area, 800)).toEqual({ x: 0, y: 250 })
  })
})
