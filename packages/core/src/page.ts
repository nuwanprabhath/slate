import { LoroDoc, LoroMap, type ContainerID } from 'loro-crdt'
import { contentToJSON, writeContent } from './content'
import { withHandles, type Handles } from './handles'
import { newId } from './ids'
import type { PMJSON } from './plaintext'

export interface BoxState {
  id: string
  x: number
  y: number
  width: number
  private: boolean
  /** Stacking order: higher is in front; ties by id. Pages saved before stacking read as 0. */
  z: number
  /** Minimum height the person dragged the box to; it still grows with its content. Unset: content height. */
  height?: number
  /** Loro container that loro-prosemirror binds this box's editor to. */
  contentId: ContainerID
}

/** A box as data, without its id: what a box cut, copy or duplicate carries. */
export interface BoxCopy {
  x: number
  y: number
  width: number
  height?: number
  private: boolean
  /** The box's top-level blocks (images keep their `slate-blob:` addresses). */
  content: PMJSON[]
}

/** `height: null` clears the min height. */
export type BoxPatch = Partial<Pick<BoxState, 'x' | 'y' | 'width' | 'private' | 'z'>> & { height?: number | null }

function toState(id: string, m: LoroMap, h: Handles): BoxState {
  const height = h.own(m.get('height'))
  return {
    id,
    x: Number(h.own(m.get('x')) ?? 0),
    y: Number(h.own(m.get('y')) ?? 0),
    width: Number(h.own(m.get('width')) ?? 0),
    private: h.own(m.get('private')) === true,
    z: Number(h.own(m.get('z')) ?? 0),
    ...(typeof height === 'number' && height > 0 ? { height } : {}),
    contentId: (h.own(m.get('content')) as LoroMap).id,
  }
}

export class PageDoc {
  readonly doc: LoroDoc

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc
  }

  static fromUpdates(updates: Uint8Array[]): PageDoc {
    const doc = new LoroDoc()
    if (updates.length > 0) doc.importBatch(updates)
    return new PageDoc(doc)
  }

  private boxes(h: Handles): LoroMap {
    return h.own(this.doc.getMap('boxes'))
  }

  private boxMap(id: string, h: Handles): LoroMap | undefined {
    const value = h.own(this.boxes(h).get(id))
    return value instanceof LoroMap ? value : undefined
  }

  /**
   * A box and its content in one commit: `content`'s blocks, else (none, or an empty list) one empty paragraph.
   * Never an empty content map or an empty doc, even for a moment: the editor fills either with its own doc, so a
   * device that synced the box first would write one too, and the two writes to the same keys hide one side's text.
   */
  addBox(init: { x: number; y: number; width: number; content?: PMJSON[] }): string {
    return withHandles((h) => {
      const id = newId()
      const z = this.maxZ() + 1
      const box = h.own(this.boxes(h).setContainer(id, h.own(new LoroMap())))
      box.set('x', init.x)
      box.set('y', init.y)
      box.set('width', init.width)
      box.set('private', false)
      box.set('z', z)
      writeContent(h.own(box.setContainer('content', h.own(new LoroMap()))), init.content?.length ? init.content : [{ type: 'paragraph' }], this.doc)
      this.doc.commit()
      return id
    })
  }

  copyBox(id: string): BoxCopy | undefined {
    return withHandles((h) => {
      const m = this.boxMap(id, h)
      if (!m) return undefined
      const box = toState(id, m, h)
      const content = h.own(m.get('content'))
      if (!(content instanceof LoroMap)) return undefined
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        ...(box.height !== undefined ? { height: box.height } : {}),
        private: box.private,
        content: blocksOf(contentToJSON(content)),
      }
    })
  }

  /** Adds boxes from copies in one commit (one undo step), in front of every box, in the given order. Fresh ids unless `ids` names them. */
  addBoxCopies(copies: BoxCopy[], ids?: string[], origin?: string): string[] {
    return withHandles((h) => {
      let z = this.maxZ()
      const boxes = this.boxes(h)
      const added = copies.map((copy, i) => {
        const id = ids?.[i] ?? newId()
        const box = h.own(boxes.setContainer(id, h.own(new LoroMap())))
        box.set('x', copy.x)
        box.set('y', copy.y)
        box.set('width', copy.width)
        if (copy.height !== undefined) box.set('height', copy.height)
        box.set('private', copy.private)
        box.set('z', ++z)
        // An empty copy gets the empty paragraph a new box has, in this commit (see addBox).
        writeContent(h.own(box.setContainer('content', h.own(new LoroMap()))), copy.content.length > 0 ? copy.content : [{ type: 'paragraph' }], this.doc)
        return id
      })
      this.doc.commit(origin === undefined ? undefined : { origin })
      return added
    })
  }

  getBox(id: string): BoxState | undefined {
    return withHandles((h) => {
      const m = this.boxMap(id, h)
      return m ? toState(id, m, h) : undefined
    })
  }

  listBoxes(): BoxState[] {
    return withHandles((h) => {
      const boxes = this.boxes(h)
      return boxes
        .keys()
        .sort()
        .flatMap((id) => {
          const m = h.own(boxes.get(id))
          return m instanceof LoroMap ? [toState(id, m, h)] : []
        })
    })
  }

  /**
   * The box's content container itself, for code that binds an editor to it or writes into it. It is a handle and
   * the caller's to free: until then, or until garbage collection, the page's memory stays (see handles.ts). To
   * read the content, use `boxContent`.
   */
  contentMap(id: string): LoroMap | undefined {
    return withHandles((h) => {
      const content = h.own(this.boxMap(id, h)?.get('content'))
      return content instanceof LoroMap ? h.keep(content) : undefined
    })
  }

  /** ProseMirror-shaped JSON of the box's content, or null for an empty box or one that is not there. Holds no handle. */
  boxContent(id: string): PMJSON | null {
    return withHandles((h) => {
      const content = h.own(this.boxMap(id, h)?.get('content'))
      return content instanceof LoroMap ? contentToJSON(content) : null
    })
  }

  updateBox(id: string, patch: BoxPatch): void {
    this.updateBoxes(new Map([[id, patch]]))
  }

  /** Patches several boxes in one commit (one undo step). */
  updateBoxes(patches: Map<string, BoxPatch>, origin?: string): void {
    withHandles((h) => {
      for (const [id, patch] of patches) {
        const m = this.boxMap(id, h)
        if (!m) continue
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) m.delete(key)
          else if (value !== undefined) m.set(key, value)
        }
      }
      this.doc.commit(origin === undefined ? undefined : { origin })
    })
  }

  private maxZ(): number {
    return this.listBoxes().reduce((max, b) => Math.max(max, b.z), 0)
  }

  /** Box ids from back to front: by z, then id (pages saved before stacking are all z 0). */
  stackOrder(): string[] {
    return this.listBoxes()
      .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((b) => b.id)
  }

  /** Puts the box in front of every other one. Returns false (and writes nothing) when it already is. */
  bringToFront(id: string, origin?: string): boolean {
    const order = this.stackOrder()
    if (!order.includes(id) || order.at(-1) === id) return false
    this.updateBoxes(new Map([[id, { z: this.maxZ() + 1 }]]), origin)
    return true
  }

  moveBoxes(ys: Map<string, number>, origin?: string): void {
    withHandles((h) => {
      for (const [id, y] of ys) this.boxMap(id, h)?.set('y', y)
      this.doc.commit(origin === undefined ? undefined : { origin })
    })
  }

  /** Set on imported pages: their boxes keep the source app's coordinates until the editor has measured them. */
  needsLayout(): boolean {
    return withHandles((h) => h.own(h.own(this.doc.getMap('meta')).get('needsLayout')) === true)
  }

  setNeedsLayout(on: boolean): void {
    withHandles((h) => {
      h.own(this.doc.getMap('meta')).set('needsLayout', on)
      this.doc.commit({ origin: 'sys:layout' })
    })
  }

  deleteBoxes(ids: string[], origin?: string): void {
    withHandles((h) => {
      const boxes = this.boxes(h)
      for (const id of ids) boxes.delete(id)
      this.doc.commit(origin === undefined ? undefined : { origin })
    })
  }

  deleteBox(id: string, origin?: string): void {
    this.deleteBoxes([id], origin)
  }
}

/** A box's blocks, with the one empty paragraph a new box starts with counted as no content. */
function blocksOf(content: PMJSON | null): PMJSON[] {
  const blocks = content?.content ?? []
  const only = blocks.length === 1 ? blocks[0]! : undefined
  return only?.type === 'paragraph' && only.content === undefined && only.attrs === undefined ? [] : blocks
}
