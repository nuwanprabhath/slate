import { LoroDoc, LoroMap, type ContainerID } from 'loro-crdt'
import { contentToJSON, writeContent } from './content'
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

function toState(id: string, m: LoroMap): BoxState {
  const height = m.get('height')
  return {
    id,
    x: Number(m.get('x') ?? 0),
    y: Number(m.get('y') ?? 0),
    width: Number(m.get('width') ?? 0),
    private: m.get('private') === true,
    z: Number(m.get('z') ?? 0),
    ...(typeof height === 'number' && height > 0 ? { height } : {}),
    contentId: (m.get('content') as LoroMap).id,
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

  private get boxes(): LoroMap {
    return this.doc.getMap('boxes')
  }

  private boxMap(id: string): LoroMap | undefined {
    const value = this.boxes.get(id)
    return value instanceof LoroMap ? value : undefined
  }

  addBox(init: { x: number; y: number; width: number }): string {
    const id = newId()
    const z = this.maxZ() + 1
    const box = this.boxes.setContainer(id, new LoroMap())
    box.set('x', init.x)
    box.set('y', init.y)
    box.set('width', init.width)
    box.set('private', false)
    box.set('z', z)
    box.setContainer('content', new LoroMap())
    this.doc.commit()
    return id
  }

  copyBox(id: string): BoxCopy | undefined {
    const box = this.getBox(id)
    const content = this.contentMap(id)
    if (!box || !content) return undefined
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      ...(box.height !== undefined ? { height: box.height } : {}),
      private: box.private,
      content: contentToJSON(content)?.content ?? [],
    }
  }

  /** Adds boxes from copies in one commit (one undo step), in front of every box, in the given order. Fresh ids unless `ids` names them. */
  addBoxCopies(copies: BoxCopy[], ids?: string[], origin?: string): string[] {
    let z = this.maxZ()
    const added = copies.map((copy, i) => {
      const id = ids?.[i] ?? newId()
      const box = this.boxes.setContainer(id, new LoroMap())
      box.set('x', copy.x)
      box.set('y', copy.y)
      box.set('width', copy.width)
      if (copy.height !== undefined) box.set('height', copy.height)
      box.set('private', copy.private)
      box.set('z', ++z)
      const content = box.setContainer('content', new LoroMap())
      if (copy.content.length > 0) writeContent(content, copy.content, this.doc)
      return id
    })
    this.doc.commit(origin === undefined ? undefined : { origin })
    return added
  }

  getBox(id: string): BoxState | undefined {
    const m = this.boxMap(id)
    return m ? toState(id, m) : undefined
  }

  listBoxes(): BoxState[] {
    return this.boxes
      .keys()
      .sort()
      .flatMap((id) => {
        const m = this.boxMap(id)
        return m ? [toState(id, m)] : []
      })
  }

  contentMap(id: string): LoroMap | undefined {
    const content = this.boxMap(id)?.get('content')
    return content instanceof LoroMap ? content : undefined
  }

  updateBox(id: string, patch: BoxPatch): void {
    this.updateBoxes(new Map([[id, patch]]))
  }

  /** Patches several boxes in one commit (one undo step). */
  updateBoxes(patches: Map<string, BoxPatch>, origin?: string): void {
    for (const [id, patch] of patches) {
      const m = this.boxMap(id)
      if (!m) continue
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) m.delete(key)
        else if (value !== undefined) m.set(key, value)
      }
    }
    this.doc.commit(origin === undefined ? undefined : { origin })
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
    for (const [id, y] of ys) this.boxMap(id)?.set('y', y)
    this.doc.commit(origin === undefined ? undefined : { origin })
  }

  /** Set on imported pages: their boxes keep the source app's coordinates until the editor has measured them. */
  needsLayout(): boolean {
    return this.doc.getMap('meta').get('needsLayout') === true
  }

  setNeedsLayout(on: boolean): void {
    this.doc.getMap('meta').set('needsLayout', on)
    this.doc.commit({ origin: 'sys:layout' })
  }

  deleteBoxes(ids: string[], origin?: string): void {
    for (const id of ids) this.boxes.delete(id)
    this.doc.commit(origin === undefined ? undefined : { origin })
  }

  deleteBox(id: string, origin?: string): void {
    this.boxes.delete(id)
    this.doc.commit(origin === undefined ? undefined : { origin })
  }
}
