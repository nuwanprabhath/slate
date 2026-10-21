import { LoroDoc, type LoroTreeNode, type TreeID } from 'loro-crdt'
import { newId } from './ids'

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
  children: TreeItem[]
}

export const SECTION_COLORS: readonly string[] = ['#2e9e5b', '#e45b5b', '#18a3c8', '#1f7ae0', '#e83e8c', '#f07d1a', '#f2c12e', '#8e6bd8']

const ALLOWED_PARENTS: Record<NodeKind, ReadonlyArray<NodeKind | 'root'>> = {
  sectionGroup: ['root', 'sectionGroup'],
  section: ['root', 'sectionGroup'],
  page: ['section'],
}

function toItem(n: LoroTreeNode): TreeItem {
  const d = n.data
  return {
    id: n.id,
    kind: d.get('kind') as NodeKind,
    title: String(d.get('title') ?? ''),
    color: (d.get('color') as string | undefined) ?? null,
    level: Number(d.get('level') ?? 0),
    pageId: (d.get('pageId') as string | undefined) ?? null,
    children: (n.children() ?? []).map(toItem),
  }
}

function collectPageIds(item: TreeItem): string[] {
  return [...(item.pageId ? [item.pageId] : []), ...item.children.flatMap(collectPageIds)]
}

export class NotebookDoc {
  readonly doc: LoroDoc

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc
    this.tree.enableFractionalIndex(0)
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

  private get tree() {
    return this.doc.getTree('tree')
  }

  get name(): string {
    return (this.doc.getMap('meta').get('name') as string | undefined) ?? 'Untitled notebook'
  }

  rename(name: string): void {
    this.doc.getMap('meta').set('name', name)
    this.doc.commit()
  }

  items(): TreeItem[] {
    return this.tree.roots().map(toItem)
  }

  get(id: TreeID): TreeItem | undefined {
    const n = this.node(id)
    return n ? toItem(n) : undefined
  }

  addSectionGroup(title: string, parent?: TreeID): TreeID {
    return this.create('sectionGroup', parent, { title })
  }

  addSection(title: string, parent?: TreeID, color: string = SECTION_COLORS[0]): TreeID {
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
    const target = this.requireNode(targetId)
    this.assertPlacement(this.kindOf(id), target.parent()?.id)
    this.requireNode(id).moveBefore(target)
    this.doc.commit()
  }

  moveAfter(id: TreeID, targetId: TreeID): void {
    const target = this.requireNode(targetId)
    this.assertPlacement(this.kindOf(id), target.parent()?.id)
    this.requireNode(id).moveAfter(target)
    this.doc.commit()
  }

  moveInto(id: TreeID, parentId?: TreeID): void {
    this.assertPlacement(this.kindOf(id), parentId)
    this.tree.move(id, parentId)
    this.doc.commit()
  }

  delete(id: TreeID): string[] {
    const pageIds = this.pageIdsUnder(id)
    this.tree.delete(id)
    this.doc.commit()
    return pageIds
  }

  pageIdsUnder(id: TreeID): string[] {
    const item = this.get(id)
    return item ? collectPageIds(item) : []
  }

  allPageIds(): string[] {
    return this.items().flatMap(collectPageIds)
  }

  private node(id: TreeID): LoroTreeNode | undefined {
    if (!this.tree.has(id)) return undefined
    const n = this.tree.getNodeByID(id)
    return n && !n.isDeleted() ? n : undefined
  }

  private requireNode(id: TreeID): LoroTreeNode {
    const n = this.node(id)
    if (!n) throw new Error(`Unknown notebook node ${id}`)
    return n
  }

  private kindOf(id: TreeID): NodeKind {
    return this.requireNode(id).data.get('kind') as NodeKind
  }

  private assertPlacement(kind: NodeKind, parentId: TreeID | undefined): void {
    const parentKind = parentId === undefined ? 'root' : this.kindOf(parentId)
    if (!ALLOWED_PARENTS[kind].includes(parentKind)) throw new Error(`A ${kind} cannot be placed in ${parentKind}`)
  }

  private create(kind: NodeKind, parent: TreeID | undefined, data: Record<string, string | number>): TreeID {
    this.assertPlacement(kind, parent)
    const node = this.tree.createNode(parent)
    node.data.set('kind', kind)
    for (const [key, value] of Object.entries(data)) node.data.set(key, value)
    this.doc.commit()
    return node.id
  }

  private setData(id: TreeID, key: string, value: string | number): void {
    this.requireNode(id).data.set(key, value)
    this.doc.commit()
  }
}
