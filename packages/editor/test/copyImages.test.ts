// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { buildExtensions } from '../src/extensions'
import { mayHoldImages, storeDataImages } from '../src/clipboard'
import { copyWithImages, pasteHtml } from '../src/images'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))

const IMG = 'slate-blob://blob/aaaa.png'

function make(html: string): Editor {
  const editor = new Editor({ extensions: buildExtensions(), content: html })
  editors.push(editor)
  return editor
}

function selectAll(editor: Editor): void {
  const { doc } = editor.state
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)))
}

function services() {
  const rich: Array<[string, string]> = []
  const images: string[] = []
  return {
    rich,
    images,
    copyImage: async (url: string) => (images.push(url), true),
    copyRich: async (text: string, html: string) => void rich.push([text, html]),
  }
}

const clipboardEvent = (type: 'copy' | 'cut') => new Event(type, { cancelable: true }) as ClipboardEvent

describe('copyWithImages', () => {
  it('hands text with images to main as plain text and HTML, the images still by their note address', () => {
    const editor = make(`<p>Before</p><img src="${IMG}"><img src="${IMG}"><p>After</p>`)
    selectAll(editor)
    const s = services()
    const event = clipboardEvent('copy')
    expect(copyWithImages(editor.view, event, s)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(s.rich).toHaveLength(1)
    const [text, html] = s.rich[0]!
    expect(text).toBe('Before\nAfter')
    expect(html.match(/<img src="slate-blob:\/\/blob\/aaaa\.png"/g)).toHaveLength(2)
    expect(html).toContain('<p>Before</p>')
    expect(editor.state.doc.childCount).toBe(4)
  })

  it('cut also removes the selection', () => {
    const editor = make(`<p>Before</p><img src="${IMG}"><p>After</p>`)
    selectAll(editor)
    const s = services()
    expect(copyWithImages(editor.view, clipboardEvent('cut'), s)).toBe(true)
    expect(s.rich).toHaveLength(1)
    expect(editor.state.doc.textContent).toBe('')
    let images = 0
    editor.state.doc.descendants((n) => void (n.type.name === 'image' && images++))
    expect(images).toBe(0)
  })

  it('copies one clicked image as a picture, and leaves text-only copies to the editor', () => {
    const editor = make(`<p>Before</p><img src="${IMG}"><p>After</p>`)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 8)))
    const s = services()
    expect(copyWithImages(editor.view, clipboardEvent('copy'), s)).toBe(true)
    expect(s.images).toEqual([IMG])

    const text = make('<p>Just words</p>')
    selectAll(text)
    const event = clipboardEvent('copy')
    expect(copyWithImages(text.view, event, s)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(s.rich).toEqual([])
  })
})

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const DATA = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`

describe('storeDataImages', () => {
  it('stores each embedded image and points the HTML at the stored copy', async () => {
    const put: Array<[number[], string]> = []
    const html = await storeDataImages(`<p>a</p><img src="${DATA}"><img src="https://x.io/b.png">`, async (bytes, mime) => {
      put.push([Array.from(bytes), mime])
      return IMG
    })
    expect(put).toEqual([[Array.from(PNG), 'image/png']])
    expect(html).toBe(`<p>a</p><img src="${IMG}"><img src="https://x.io/b.png">`)
  })

  it('drops an embedded image that cannot be stored or is not a picture format', async () => {
    const html = await storeDataImages(`<img src="${DATA}"><img src="data:image/svg+xml,%3Csvg%3E"><img src="data:text/html;base64,PGI+">`, async () => {
      throw new Error('too large')
    })
    expect(html).toBe('')
  })
})

describe('pasted HTML checks', () => {
  it('finds pictures by what the parser reads, so an entity or a slash cannot hide one', async () => {
    const put: string[] = []
    const store = async (_bytes: Uint8Array, mime: string) => (put.push(mime), IMG)
    expect(await storeDataImages(`<img src="&#100;ata:image/png;base64,${DATA.split(',')[1]}"><img/src="${DATA}"><img src=" \tda\nta:image/png;base64,${DATA.split(',')[1]}">`, store)).toBe(
      `<img src="${IMG}"><img src="${IMG}"><img src="${IMG}">`,
    )
    expect(put).toHaveLength(3)
  })

  it('stays fast on a crafted paste', () => {
    const start = performance.now()
    mayHoldImages('<img '.repeat(40_000))
    mayHoldImages(`<p>${'x'.repeat(200_000)}</p>`)
    expect(performance.now() - start).toBeLessThan(250)
  })
})

describe('pasteHtml', () => {
  it('pastes embedded images as stored images, never as data in the page', async () => {
    const editor = make('<p></p>')
    pasteHtml(editor.view, `<p>Before</p><img src="${DATA}"><p>After</p>`, async () => IMG)
    await new Promise((r) => setTimeout(r, 0))
    const srcs: string[] = []
    editor.state.doc.descendants((n) => void (n.type.name === 'image' && srcs.push(String(n.attrs.src))))
    expect(srcs).toEqual([IMG])
    expect(editor.state.doc.textContent).toBe('BeforeAfter')
  })

  it('never keeps image bytes in the page, even when the paste hides them from a text check', async () => {
    const editor = make('<p></p>')
    pasteHtml(editor.view, `<p>a</p><img/src="data:image/svg+xml;base64,PHN2Zz4="><img src="&#100;ata:image/png;base64,${DATA.split(',')[1]}">`, async () => IMG)
    await new Promise((r) => setTimeout(r, 0))
    const srcs: string[] = []
    editor.state.doc.descendants((n) => void (n.type.name === 'image' && srcs.push(String(n.attrs.src))))
    expect(srcs).toEqual([IMG])
  })
})
