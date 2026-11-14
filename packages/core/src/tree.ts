import { LoroDoc, type LoroMap, type LoroTree, type LoroTreeNode, type TreeID } from 'loro-crdt'
import { withHandles, type Handles } from './handles'
import { newId } from './ids'

export type Access = 'read' | 'readwrite'
/** Key for a grant that covers the whole notebook. */
export const NOTEBOOK_SCOPE = 'notebook'

function readAccess(value: unknown): Access | null {
  return value === 'read' || value === 'readwrite' ? value : null
}

export type NodeKind = 'sectionGroup' | 'section' | 'page'

export interface TreeItem {
  id: TreeID
  kind: NodeKind
  title: string
  color: string | null
  /** Page indent level (0–2), like OneNote subpages. Always 0 for sections and groups. */
  level: number
  /** Id of the page's own Loro document. Null for sections and groups. */
  pageId: string | null
  /** The explicit AI access grant on this node, not the inherited one. */
  access: Access | null
  children: TreeItem[]
}

export const SECTION_COLORS: readonly string[] = ['#2e9e5b', '#e45b5b', '#18a3c8', '#1f7ae0', '#e83e8c', '#f07d1a', '#f2c12e', '#8e6bd8']

const ALLOWED_PARENTS: Record<NodeKind, ReadonlyArray<NodeKind | 'root'>> = {
  sectionGroup: ['root', 'sectionGroup'],
  section: ['root', 'sectionGroup'],
  page: ['section'],
}

function toItem(n: LoroTreeNode, access: LoroMap, h: Handles): TreeItem {
  const d = h.own(n.data)
  return {
    id: n.id,
    kind: h.own(d.get('kind')) as NodeKind,
    title: String(h.own(d.get('title')) ?? ''),
    color: (h.own(d.get('color')) as string | undefined) ?? null,
    level: Number(h.own(d.get('level')) ?? 0),
    pageId: (h.own(d.get('pageId')) as string | undefined) ?? null,
    access: readAccess(h.own(access.get(n.id))),
    children: (h.own(n.children()) ?? []).map((c) => toItem(c, access, h)),
  }
}

function collectPageIds(item: TreeItem): string[] {
  return [...(item.pageId ? [item.pageId] : []), ...item.children.flatMap(collectPageIds)]
}

export class NotebookDoc {
  readonly doc: LoroDoc

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc
    withHandles((h) => this.tree(h).enableFractionalIndex(0))
  }

  static create(name: string): NotebookDoc {
    const nb = new NotebookDoc()
    nb.rename(name)
    return nb
  }

  static fromUpdates(updates: Uint8Array[]): NotebookDoc {
    const doc = new LoroDoc()
    if (updates.length > 0) doc.importBatch(updates)
    return new NotebookDoc(doc)
  }

  private tree(h: Handles): LoroTree {
    return h.own(this.doc.getTree('tree'))
  }

  get name(): string {
    return withHandles((h) => (h.own(h.own(this.doc.getMap('meta')).get('name')) as string | undefined) ?? 'Untitled notebook')
  }

  /**
   * When each device last opened this notebook, so a newly synced device can open the one the
   * user works in. Keyed by device id, so devices never write the same key and merges are clean.
   */
  openOn(): Record<string, number> {
    return withHandles((h) => h.own(this.doc.getMap('openOn')).toJSON() as Record<string, number>)
  }

  markOpen(deviceId: string, at: number): void {
    withHandles((h) => {
      h.own(this.doc.getMap('openOn')).set(deviceId, at)
      this.doc.commit()
    })
  }

  rename(name: string): void {
    withHandles((h) => {
      h.own(this.doc.getMap('meta')).set('name', name)
      this.doc.commit()
    })
  }

  items(): TreeItem[] {
    return withHandles((h) => {
      const access = this.accessMap(h)
      return h.own(this.tree(h).roots()).map((r) => toItem(r, access, h))
    })
  }

  get(id: TreeID): TreeItem | undefined {
    return withHandles((h) => {
      const n = this.node(id, h)
      return n ? toItem(n, this.accessMap(h), h) : undefined
    })
  }

  addSectionGroup(title: string, parent?: TreeID): TreeID {
    return this.create('sectionGroup', parent, { title })
  }

  addSection(title: string, parent?: TreeID, color: string = SECTION_COLORS[0]!): TreeID {
    return this.create('section', parent, { title, color })
  }

  addPage(sectionId: TreeID, title = 'Untitled page'): { id: TreeID; pageId: string } {
    const pageId = newId()
    return { id: this.create('page', sectionId, { title, pageId, level: 0 }), pageId }
  }

  setTitle(id: TreeID, title: string): void {
    this.setData(id, 'title', title)
  }

  setColor(id: TreeID, color: string): void {
    this.setData(id, 'color', color)
  }

  setLevel(id: TreeID, level: number): void {
    this.setData(id, 'level', Math.max(0, Math.min(2, Math.round(level))))
  }

  moveBefore(id: TreeID, targetId: TreeID): void {
    withHandles((h) => {
      const target = this.requireNode(targetId, h)
      this.assertPlacement(this.kindOf(id, h), h.own(target.parent())?.id, h)
      this.requireNode(id, h).moveBefore(target)
      this.doc.commit()
    })
  }

  moveAfter(id: TreeID, targetId: TreeID): void {
    withHandles((h) => {
      const target = this.requireNode(targetId, h)
      this.assertPlacement(this.kindOf(id, h), h.own(target.parent())?.id, h)
      this.requireNode(id, h).moveAfter(target)
      this.doc.commit()
    })
  }

  moveInto(id: TreeID, parentId?: TreeID): void {
    withHandles((h) => {
      this.assertPlacement(this.kindOf(id, h), parentId, h)
      this.tree(h).move(id, parentId)
      this.doc.commit()
    })
  }

  delete(id: TreeID): string[] {
    const pageIds = this.pageIdsUnder(id)
    withHandles((h) => {
      this.tree(h).delete(id)
      this.doc.commit()
    })
    return pageIds
  }

  pageIdsUnder(id: TreeID): string[] {
    const item = this.get(id)
    return item ? collectPageIds(item) : []
  }

  allPageIds(): string[] {
    return this.items().flatMap(collectPageIds)
  }

  private accessMap(h: Handles): LoroMap {
    return h.own(this.doc.getMap('access'))
  }

  accessOf(target: TreeID | typeof NOTEBOOK_SCOPE): Access | null {
    return withHandles((h) => readAccess(h.own(this.accessMap(h).get(target))))
  }

  setAccess(target: TreeID | typeof NOTEBOOK_SCOPE, access: Access | null): void {
    withHandles((h) => {
      if (access) this.accessMap(h).set(target, access)
      else this.accessMap(h).delete(target)
      this.doc.commit()
    })
  }

  /** Deny by default: the nearest explicit grant on the node, its ancestors, then the notebook. */
  effectiveAccess(id: TreeID): Access | null {
    return withHandles((h) => {
      const start = this.node(id, h)
      if (!start) return null
      const grants = this.accessMap(h)
      for (let n: LoroTreeNode | undefined = start; n; n = h.own(n.parent())) {
        const access = readAccess(h.own(grants.get(n.id)))
        if (access) return access
      }
      return readAccess(h.own(grants.get(NOTEBOOK_SCOPE)))
    })
  }

  findPage(pageId: string): TreeItem | undefined {
    const walk = (items: TreeItem[]): TreeItem | undefined => {
      for (const item of items) {
        if (item.pageId === pageId) return item
        const found = walk(item.children)
        if (found) return found
      }
      return undefined
    }
    return walk(this.items())
  }

  private node(id: TreeID, h: Handles): LoroTreeNode | undefined {
    const tree = this.tree(h)
    if (!tree.has(id)) return undefined
    const n = h.own(tree.getNodeByID(id))
    return n && !n.isDeleted() ? n : undefined
  }

  private requireNode(id: TreeID, h: Handles): LoroTreeNode {
    const n = this.node(id, h)
    if (!n) throw new Error(`Unknown notebook node ${id}`)
    return n
  }

  private kindOf(id: TreeID, h: Handles): NodeKind {
    return h.own(h.own(this.requireNode(id, h).data).get('kind')) as NodeKind
  }

  private assertPlacement(kind: NodeKind, parentId: TreeID | undefined, h: Handles): void {
    const parentKind = parentId === undefined ? 'root' : this.kindOf(parentId, h)
    if (!ALLOWED_PARENTS[kind].includes(parentKind)) throw new Error(`A ${kind} cannot be placed in ${parentKind}`)
  }

  private create(kind: NodeKind, parent: TreeID | undefined, data: Record<string, string | number>): TreeID {
    return withHandles((h) => {
      this.assertPlacement(kind, parent, h)
      const node = h.own(this.tree(h).createNode(parent))
      const fields = h.own(node.data)
      fields.set('kind', kind)
      for (const [key, value] of Object.entries(data)) fields.set(key, value)
      this.doc.commit()
      return node.id
    })
  }

  private setData(id: TreeID, key: string, value: string | number): void {
    withHandles((h) => {
      h.own(this.requireNode(id, h).data).set(key, value)
      this.doc.commit()
    })
  }
}
