import { CH } from '../shared/ipc'
import type { BlobStore } from './blobs'
import type { IpcRegistrar } from './ipcGuard'

/** The most image bytes one copy embeds; past it the rest are left out so a copy never stalls main. */
export const COPY_IMAGE_BUDGET = 32 * 1024 * 1024
export const MAX_COPY_IMAGES = 200
const MAX_COPY_LENGTH = 16 * 1024 * 1024
const NOTE_SRC = ' src="slate-blob:'

export interface CopyClipboard {
  writeRich(item: Record<'text/plain' | 'text/html', string>): Promise<void>
  /** Puts one stored picture on the clipboard; false when its bytes are not a picture. */
  writeImage(bytes: Uint8Array): Promise<boolean>
}

/**
 * Other apps cannot load slate-blob:// (Notes draws a "?", OneNote drops the picture), so each note
 * image goes onto the clipboard as its bytes in a data URL. The HTML comes from the renderer, so the
 * scan is a single indexOf pass (a regex here backtracked for minutes on unclosed tags), each image
 * is read once, and reading stops at the first picture past the budget or at MAX_COPY_IMAGES.
 */
export function embedNoteImages(html: string, read: BlobStore['readForUrl'], budget = COPY_IMAGE_BUDGET): string {
  const dataUrls = new Map<string, { size: number; dataUrl: string } | null>()
  let left = budget
  let embedded = 0
  let stopped = false
  let out = ''
  let at = 0
  for (let start = html.indexOf('<img', at); start >= 0; start = html.indexOf('<img', at)) {
    const end = html.indexOf('>', start)
    if (end < 0) break
    const tag = html.slice(start, end + 1)
    out += html.slice(at, start)
    at = end + 1
    const srcAt = tag.indexOf(NOTE_SRC)
    const urlStart = srcAt + ' src="'.length
    const urlEnd = srcAt < 0 ? -1 : tag.indexOf('"', urlStart)
    if (urlEnd < 0) {
      out += tag
      continue
    }
    if (stopped || embedded >= MAX_COPY_IMAGES) continue
    const url = tag.slice(urlStart, urlEnd)
    if (!dataUrls.has(url)) {
      const found = read(url)
      dataUrls.set(url, found && { size: found.bytes.byteLength, dataUrl: `data:${found.mime};base64,${Buffer.from(found.bytes).toString('base64')}` })
    }
    const image = dataUrls.get(url)
    if (!image) continue
    if (image.size > left) {
      stopped = true
      continue
    }
    left -= image.size
    embedded++
    out += tag.slice(0, urlStart) + image.dataUrl + tag.slice(urlEnd)
  }
  return out + html.slice(at)
}

/**
 * The two copies that put note images on the clipboard. Each tells `onCopied` what it wrote once it
 * is there, so a lock straight after the copy finds it and clears it.
 */
export function registerCopyIpc(ipc: IpcRegistrar, blobs: () => Pick<BlobStore, 'readForUrl'>, clipboard: CopyClipboard, onCopied: (text: string) => void): void {
  ipc.handle(CH.blobsCopyRich, async (_e, text: unknown, html: unknown) => {
    if (typeof text !== 'string' || typeof html !== 'string' || text.length > MAX_COPY_LENGTH || html.length > MAX_COPY_LENGTH) throw new Error('copy: expected the text and HTML of a selection')
    await clipboard.writeRich({ 'text/plain': text, 'text/html': embedNoteImages(html, (url) => blobs().readForUrl(url)) })
    onCopied(text)
  })
  ipc.handle(CH.blobsCopyImage, async (_e, url: unknown) => {
    const found = typeof url === 'string' ? blobs().readForUrl(url) : null
    if (!found || !(await clipboard.writeImage(found.bytes))) return false
    onCopied('')
    return true
  })
}
