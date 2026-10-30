import { CH } from '../shared/ipc'
import type { BlobStore } from './blobs'
import type { IpcRegistrar } from './ipcGuard'

/** The most image bytes one copy embeds; past it the rest are left out so a copy never stalls main. */
export const COPY_IMAGE_BUDGET = 32 * 1024 * 1024
const MAX_COPY_LENGTH = 16 * 1024 * 1024

// The editor's own serializer wrote this HTML, so an image is always `<img src="…"…>` with a quoted src.
const NOTE_IMAGE = /<img\s[^>]*?src="(slate-blob:[^"]*)"[^>]*>/g

/**
 * Other apps cannot load slate-blob:// (Notes draws a "?", OneNote drops the picture), so each note
 * image goes onto the clipboard as its bytes in a data URL.
 */
export function embedNoteImages(html: string, read: BlobStore['readForUrl'], budget = COPY_IMAGE_BUDGET): string {
  let left = budget
  return html.replace(NOTE_IMAGE, (tag, url: string) => {
    const found = read(url)
    if (!found || found.bytes.byteLength > left) return ''
    left -= found.bytes.byteLength
    return tag.replace(`src="${url}"`, `src="data:${found.mime};base64,${Buffer.from(found.bytes).toString('base64')}"`)
  })
}

export function registerCopyIpc(ipc: IpcRegistrar, blobs: () => Pick<BlobStore, 'readForUrl'>, write: (item: Record<'text/plain' | 'text/html', string>) => Promise<void>): void {
  ipc.handle(CH.blobsCopyRich, async (_e, text: unknown, html: unknown) => {
    if (typeof text !== 'string' || typeof html !== 'string' || text.length > MAX_COPY_LENGTH || html.length > MAX_COPY_LENGTH) throw new Error('copy: expected the text and HTML of a selection')
    await write({ 'text/plain': text, 'text/html': embedNoteImages(html, (url) => blobs().readForUrl(url)) })
  })
}
