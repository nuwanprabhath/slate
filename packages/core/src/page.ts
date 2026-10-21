import { LoroDoc, LoroMap, type ContainerID } from 'loro-crdt'
import { newId } from './ids'

export interface BoxState {
  id: string
  x: number
  y: number
  width: number
  private: boolean
  /** Loro container that loro-prosemirror binds this box's editor to. */
  contentId: ContainerID
}

export type BoxPatch = Partial<Pick<BoxState, 'x' | 'y' | 'width' | 'private'>>

function toState(id: string, m: LoroMap): BoxState {
  return {
    id,
    x: Number(m.get('x') ?? 0),
    y: Number(m.get('y') ?? 0),
    width: Number(m.get('width') ?? 0),
    private: m.get('private') === true,
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
    const box = this.boxes.setContainer(id, new LoroMap())
    box.set('x', init.x)
    box.set('y', init.y)
    box.set('width', init.width)
    box.set('private', false)
    box.setContainer('content', new LoroMap())
    this.doc.commit()
    return id
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
    const m = this.boxMap(id)
    if (!m) return
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) m.set(key, value)
    this.doc.commit()
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

  deleteBox(id: string): void {
    this.boxes.delete(id)
    this.doc.commit()
  }
}
