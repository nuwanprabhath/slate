import { newId, toPlainText, type BoxCopy, type BoxPatch } from '@slate/core'
import { makeClipboardSerializer } from './clipboard'
import { schema } from './extensions'
import type { PageSession } from './PageSession'

type Point = { x: number; y: number }

/** Boxes cut or copied. In renderer memory only: it outlives the page (cut here, paste on another page). */
export interface BoxClip {
  mode: 'cut' | 'copy'
  /** The page the boxes came from. */
  pageId: string
  /** The source boxes' ids, back to front, matching `boxes`. */
  ids: string[]
  boxes: BoxCopy[]
  /** What went on the system clipboard: a paste uses the boxes only while it still holds this. */
  text: string
  html: string
  /** Marks the HTML as these boxes, for boxes with no text (pictures only). */
  token: string
}

/** Offset of a duplicate from its original, right and down. */
export const DUPLICATE_OFFSET = 24
const NO_IDS: ReadonlySet<string> = new Set()

let clip: BoxClip | null = null
let cutCache: { clip: BoxClip | null; pageId: string; ids: ReadonlySet<string> } | null = null
const listeners = new Set<() => void>()

function setClip(next: BoxClip | null): void {
  clip = next
  listeners.forEach((l) => l())
}

export const boxClipboard = {
  get: (): BoxClip | null => clip,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** The boxes on `pageId` marked to be cut (a stable set while nothing changes, for useSyncExternalStore). */
  cutIn(pageId: string): ReadonlySet<string> {
    if (cutCache?.clip !== clip || cutCache.pageId !== pageId) {
      cutCache = { clip, pageId, ids: clip?.mode === 'cut' && clip.pageId === pageId ? new Set(clip.ids) : NO_IDS }
    }
    return cutCache.ids
  },
  /** Esc: nothing stays marked, and Mod+V pastes the system clipboard as text again. */
  cancelCut(): void {
    if (clip?.mode === 'cut') setClip(null)
  },
  /** A cut box was edited: what was cut is no longer what the box holds, so the cut is off. */
  noteEdited(pageId: string, boxId: string): void {
    if (clip?.mode === 'cut' && clip.pageId === pageId && clip.ids.includes(boxId)) setClip(null)
  },
  clear(): void {
    setClip(null)
  },
}

const readingOrder = (boxes: BoxCopy[]): BoxCopy[] => [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)

/** The boxes as plain text, top to bottom then left to right, a blank line between boxes. */
export function clipText(boxes: BoxCopy[]): string {
  return readingOrder(boxes)
    .map((b) => toPlainText(b.content))
    .filter((t) => t !== '')
    .join('\n\n')
}

/** The boxes as HTML, one `<div>` each in reading order, inside a wrapper carrying `token`. */
export function clipHtml(boxes: BoxCopy[], token: string): string {
  const serializer = makeClipboardSerializer(schema)
  const holder = document.createElement('div')
  holder.setAttribute('data-slate-boxes', token)
  for (const box of readingOrder(boxes)) {
    const div = document.createElement('div')
    if (box.content.length > 0) div.appendChild(serializer.serializeFragment(schema.nodeFromJSON({ type: 'doc', content: box.content }).content, { document }))
    holder.appendChild(div)
  }
  return holder.outerHTML
}

/** Whether the system clipboard still holds what the box clip put there. */
export function clipMatches(c: Pick<BoxClip, 'text' | 'token'>, text: string, html: string): boolean {
  if (c.text !== '') return text.replace(/\r\n?/g, '\n') === c.text
  return html.includes(`data-slate-boxes="${c.token}"`)
}

function takeClip(session: PageSession, ids: Iterable<string>, mode: BoxClip['mode']): BoxClip | null {
  const copies = session.copyBoxes(ids)
  if (copies.length === 0) return null
  const boxes = copies.map((c) => c.copy)
  const token = newId()
  const next: BoxClip = { mode, pageId: session.pageId, ids: copies.map((c) => c.id), boxes, text: clipText(boxes), html: clipHtml(boxes, token), token }
  setClip(next)
  return next
}

/** Mod+C: holds copies of the boxes. The caller puts `text` and `html` on the system clipboard. */
export function copyBoxes(session: PageSession, ids: Iterable<string>): BoxClip | null {
  return takeClip(session, ids, 'copy')
}

/** Mod+X: marks the boxes to be moved by the next paste; nothing is removed yet. */
export function cutBoxes(session: PageSession, ids: Iterable<string>): BoxClip | null {
  return takeClip(session, ids, 'cut')
}

/** Mod+D: copies 24px right and down, as one undo step. Returns the copies' ids. */
export function duplicateBoxes(session: PageSession, ids: Iterable<string>): string[] {
  const copies = session.copyBoxes(ids).map(({ copy }) => ({ ...copy, x: copy.x + DUPLICATE_OFFSET, y: copy.y + DUPLICATE_OFFSET }))
  return session.addBoxCopies(copies)
}

/** The boxes moved so their group's top-left corner lands on `at`, keeping their layout. */
function placeAt(boxes: BoxCopy[], at: Point): BoxCopy[] {
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  return boxes.map((b) => ({ ...b, x: Math.max(0, Math.round(at.x + b.x - left)), y: Math.max(0, Math.round(at.y + b.y - top)) }))
}

/**
 * Mod+V of the box clip at `at`, as one undo step on this page. A copy adds copies (fresh ids). A cut
 * moves the boxes: on their own page they keep their ids; from another page they are removed there,
 * and undoing the paste puts them back there. After a cut, the clip holds copies, so pasting again copies.
 * Returns the ids of the boxes now in place.
 */
export async function pasteBoxes(session: PageSession, at: Point): Promise<string[]> {
  const c = clip
  if (!c) return []
  const placed = placeAt(c.boxes, at)
  if (c.mode === 'copy') return session.addBoxCopies(placed)
  setClip({ ...c, mode: 'copy' })
  if (c.pageId === session.pageId) {
    const moves = new Map<string, BoxPatch>()
    const remade: Array<{ id: string; copy: BoxCopy }> = []
    c.ids.forEach((id, i) => {
      if (session.page.getBox(id)) moves.set(id, { x: placed[i]!.x, y: placed[i]!.y })
      else remade.push({ id, copy: placed[i]! })
    })
    session.placeBoxes(moves, remade)
    return c.ids
  }
  const source = c.pageId
  let originals: Array<{ id: string; copy: BoxCopy }> = []
  const restore = () => session.editStoredPage(source, (page) => page.addBoxCopies(originals.map((o) => o.copy), originals.map((o) => o.id)))
  const take = () => session.editStoredPage(source, (page) => page.deleteBoxes(originals.map((o) => o.id)))
  const ids = await session.editStoredPage(source, (page) => {
    // The source as stored now: another device may have changed the boxes since the cut.
    originals = c.ids.flatMap((id) => {
      const copy = page.copyBox(id)
      return copy ? [{ id, copy }] : []
    })
    const current = originals.length > 0 ? placeAt(originals.map((o) => o.copy), at) : []
    const added = session.addBoxCopies(current, { undo: restore, redo: take })
    page.deleteBoxes(originals.map((o) => o.id))
    return added
  })
  // The source page is gone, or the boxes left it: what was cut is still pasted, as copies.
  return ids && ids.length > 0 ? ids : session.addBoxCopies(placed)
}
