import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import { embedNoteImages, registerCopyIpc } from './copyHtml'
import type { Handler, IpcRegistrar } from './ipcGuard'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const A = 'slate-blob://blob/aaaa.png'
const B = 'slate-blob://blob/bbbb.png'
const read = (url: string) => (url === A || url === B ? { bytes: PNG, mime: 'image/png' } : null)
const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`

describe('embedNoteImages', () => {
  it('replaces each note image with its bytes, so another app can show it', () => {
    const html = `<p>Before</p><img src="${A}" alt="one"><img src="${B}"><p>After</p>`
    expect(embedNoteImages(html, read)).toBe(`<p>Before</p><img src="${dataUrl}" alt="one"><img src="${dataUrl}"><p>After</p>`)
  })

  it('drops an image it cannot read, and the ones past the size budget, rather than leave a broken one', () => {
    expect(embedNoteImages(`<p>x</p><img src="slate-blob://blob/missing.png">`, read)).toBe('<p>x</p>')
    expect(embedNoteImages(`<img src="${A}"><img src="${B}">`, read, PNG.length)).toBe(`<img src="${dataUrl}">`)
  })

  it('leaves other images and text alone', () => {
    const html = `<p>slate-blob://blob/aaaa.png</p><img src="https://example.com/a.png">`
    expect(embedNoteImages(html, read)).toBe(html)
  })
})

function fakeRegistrar() {
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
  return { ipc, handlers }
}

describe('registerCopyIpc', () => {
  it('writes the text and the HTML with the images embedded', async () => {
    const { ipc, handlers } = fakeRegistrar()
    const written: Array<Record<string, string>> = []
    registerCopyIpc(ipc, () => ({ readForUrl: read }), async (item) => void written.push(item))
    await handlers.get(CH.blobsCopyRich)!({} as never, 'Before\n\nAfter', `<p>Before</p><img src="${A}"><p>After</p>`)
    expect(written).toEqual([{ 'text/plain': 'Before\n\nAfter', 'text/html': `<p>Before</p><img src="${dataUrl}"><p>After</p>` }])
  })

  it('refuses anything but two bounded strings from the renderer', async () => {
    const { ipc, handlers } = fakeRegistrar()
    let wrote = false
    registerCopyIpc(ipc, () => ({ readForUrl: read }), async () => void (wrote = true))
    for (const [text, html] of [[1, ''], ['', null], ['x'.repeat(16 * 1024 * 1024 + 1), ''], ['', 'x'.repeat(16 * 1024 * 1024 + 1)]]) {
      await expect(handlers.get(CH.blobsCopyRich)!({} as never, text, html)).rejects.toThrow(/copy/)
    }
    expect(wrote).toBe(false)
  })
})
