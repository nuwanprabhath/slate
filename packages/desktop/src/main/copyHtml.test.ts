import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import { embedNoteImages, MAX_COPY_IMAGES, registerCopyIpc } from './copyHtml'
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

  it('stays fast on crafted HTML, and reads each stored image at most once', () => {
    const start = performance.now()
    embedNoteImages('<img src="slate-blob:x" '.repeat(2000), read)
    embedNoteImages(`<img src="${A}"`.repeat(20_000), read)
    expect(performance.now() - start).toBeLessThan(250)

    let reads = 0
    const counted = (url: string) => (reads++, read(url))
    embedNoteImages(`<img src="${A}">`.repeat(5000), counted)
    expect(reads).toBe(1)
  })

  it('stops reading once the budget is spent, and embeds at most MAX_COPY_IMAGES pictures', () => {
    const urls = Array.from({ length: 10 }, (_, i) => `slate-blob://blob/${String(i).repeat(4)}.png`)
    let reads = 0
    const big = (url: string) => (reads++, { bytes: new Uint8Array(url ? 10 : 0), mime: 'image/png' })
    const html = urls.map((u) => `<img src="${u}">`).join('')
    expect(embedNoteImages(html, big, 25).match(/<img/g)).toHaveLength(2)
    expect(reads).toBe(3)

    const many = Array.from({ length: MAX_COPY_IMAGES + 5 }, (_, i) => `<img src="slate-blob://blob/${i}.png">`).join('')
    expect(embedNoteImages(many, (url) => ({ bytes: PNG, mime: url ? 'image/png' : '' })).match(/<img/g)).toHaveLength(MAX_COPY_IMAGES)
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
    const events: unknown[] = []
    registerCopyIpc(ipc, () => ({ readForUrl: read }), fakeClipboard(events), (text) => events.push(['copied', text]))
    await handlers.get(CH.blobsCopyRich)!({} as never, 'Before\n\nAfter', `<p>Before</p><img src="${A}"><p>After</p>`)
    // Main records what it wrote only once it is there, so a lock right after clears it.
    expect(events).toEqual([['rich', { 'text/plain': 'Before\n\nAfter', 'text/html': `<p>Before</p><img src="${dataUrl}"><p>After</p>` }], ['copied', 'Before\n\nAfter']])
  })

  it('refuses anything but two bounded strings from the renderer', async () => {
    const { ipc, handlers } = fakeRegistrar()
    const events: unknown[] = []
    registerCopyIpc(ipc, () => ({ readForUrl: read }), fakeClipboard(events), () => events.push('copied'))
    for (const [text, html] of [[1, ''], ['', null], ['x'.repeat(16 * 1024 * 1024 + 1), ''], ['', 'x'.repeat(16 * 1024 * 1024 + 1)]]) {
      await expect(handlers.get(CH.blobsCopyRich)!({} as never, text, html)).rejects.toThrow(/copy/)
    }
    expect(events).toEqual([])
  })

  it('copies one image as a picture and records it for the lock, or reports it could not', async () => {
    const { ipc, handlers } = fakeRegistrar()
    const events: unknown[] = []
    registerCopyIpc(ipc, () => ({ readForUrl: read }), fakeClipboard(events), (text) => events.push(['copied', text]))
    expect(await handlers.get(CH.blobsCopyImage)!({} as never, A)).toBe(true)
    expect(await handlers.get(CH.blobsCopyImage)!({} as never, 'slate-blob://blob/missing.png')).toBe(false)
    expect(events).toEqual([['image', Array.from(PNG)], ['copied', '']])
  })
})

function fakeClipboard(events: unknown[]) {
  return {
    writeRich: async (item: Record<'text/plain' | 'text/html', string>) => void events.push(['rich', item]),
    writeImage: async (bytes: Uint8Array) => (events.push(['image', Array.from(bytes)]), true),
  }
}
