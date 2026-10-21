import { NotebookDoc, PageDoc, SECTION_COLORS, newId, writeContent, type TreeItem } from '@slate/core'
import { GraphClient, runImport, selectionToPaths, type GraphSource, type ImportProgress, type ImportSink, type ImportState, type OneNoteNotebook, type SectionPath } from '@slate/importer'
import type { TreeID } from 'loro-crdt'
import type { BlobStore } from '../blobs'
import { DocStore } from '../store'
import { SIGN_IN_SCOPES, type AuthService } from './auth'

const notebookDocId = (id: string): string => `notebook:${id}`
const pageDocId = (id: string): string => `page:${id}`

function flatten(items: TreeItem[]): TreeItem[] {
  return items.flatMap((i) => [i, ...flatten(i.children)])
}

/**
 * Writes imported documents as update rows through its own connection, so the app's
 * external-update watcher delivers them to the renderer like any other process's writes.
 */
function docStoreSink(store: DocStore, blobs: BlobStore, pageOrder: Map<string, number>): ImportSink & ImportState {
  // Loads the notebook, applies `change`, and appends only what changed.
  const editNotebook = <T>(notebookId: string, change: (nb: NotebookDoc) => T): T => {
    const nb = NotebookDoc.fromUpdates(store.load(notebookDocId(notebookId)))
    const from = nb.doc.oplogVersion()
    const before = JSON.stringify(nb.doc.frontiers())
    const result = change(nb)
    if (JSON.stringify(nb.doc.frontiers()) !== before) store.append(notebookDocId(notebookId), nb.doc.export({ mode: 'update', from }))
    return result
  }
  // A mapped node the user has since deleted is created again.
  const ensureNode = (notebookId: string, onenoteId: string, create: (nb: NotebookDoc) => TreeID): string =>
    editNotebook(notebookId, (nb) => {
      const known = store.getMapping(onenoteId)
      if (known && nb.get(known as TreeID)) return known
      const id = create(nb)
      store.setMapping(onenoteId, id)
      return id
    })

  return {
    async ensureNotebook(onenoteId, name) {
      const known = store.getMapping(onenoteId)
      if (known && store.load(notebookDocId(known)).length > 0) return known
      const id = newId()
      const nb = NotebookDoc.create(name)
      store.append(notebookDocId(id), nb.doc.export({ mode: 'update' }))
      store.setMapping(onenoteId, id)
      return id
    },
    async ensureGroup(notebookId, parent, onenoteId, name) {
      return ensureNode(notebookId, onenoteId, (nb) => nb.addSectionGroup(name, (parent ?? undefined) as TreeID | undefined))
    },
    async ensureSection(notebookId, parent, onenoteId, name) {
      return ensureNode(notebookId, onenoteId, (nb) => {
        const sections = flatten(nb.items()).filter((i) => i.kind === 'section').length
        return nb.addSection(name, (parent ?? undefined) as TreeID | undefined, SECTION_COLORS[sections % SECTION_COLORS.length])
      })
    },
    async writePage(notebookId, sectionTreeId, onenotePageId, meta, mapped) {
      const pageId = editNotebook(notebookId, (nb) => {
        const known = store.getMapping(onenotePageId) as TreeID | undefined
        const node = known ? nb.get(known) : undefined
        if (node?.pageId) {
          if (node.title !== meta.title) nb.setTitle(node.id, meta.title)
          if (node.level !== meta.level) nb.setLevel(node.id, meta.level)
          return node.pageId
        }
        const created = nb.addPage(sectionTreeId as TreeID, meta.title)
        if (meta.level !== 0) nb.setLevel(created.id, meta.level)
        // Pages arrive in OneNote order, except a retried one, which goes before its first later sibling.
        const mine = pageOrder.get(onenotePageId)
        if (mine !== undefined) {
          const later = new Set(
            [...pageOrder].filter(([id, order]) => id !== onenotePageId && order > mine).map(([id]) => store.getMapping(id)),
          )
          const next = nb.get(sectionTreeId as TreeID)?.children.find((c) => later.has(c.id))
          if (next) nb.moveBefore(created.id, next.id)
        }
        store.setMapping(onenotePageId, created.id)
        return created.pageId
      })
      // A re-import replaces the boxes inside the existing doc rather than the rows, so a page the
      // renderer has open merges the change instead of keeping its old boxes.
      const page = PageDoc.fromUpdates(store.load(pageDocId(pageId)))
      const from = page.doc.oplogVersion()
      for (const box of page.listBoxes()) page.deleteBox(box.id)
      for (const box of mapped.boxes) {
        const id = page.addBox({ x: box.x, y: box.y, width: box.width })
        writeContent(page.contentMap(id)!, box.blocks, page.doc)
        page.doc.commit()
      }
      store.append(pageDocId(pageId), page.doc.export({ mode: 'update', from }))
    },
    async putBlob(bytes, mime) {
      return blobs.put(bytes, mime)
    },
    async get(id) {
      return store.getImportItem(id)
    },
    async set(id, record) {
      store.setImportItem(id, record)
    },
  }
}

export class ImportService {
  private readonly store: DocStore
  private readonly sink: ImportSink & ImportState
  private readonly graph: GraphSource
  private cachedTree: OneNoteNotebook[] | null = null
  private lastPaths: SectionPath[] = []
  private controller: AbortController | null = null

  constructor(private readonly deps: { dbFile: string; blobs: BlobStore; auth: AuthService; graphUrl: string; emit: (p: ImportProgress) => void }) {
    // Never compacts: compaction deletes update rows the watcher has not delivered yet.
    this.store = new DocStore(deps.dbFile, { compact: false })
    const pageOrder = new Map<string, number>()
    this.sink = docStoreSink(this.store, deps.blobs, pageOrder)
    const client = new GraphClient({ baseUrl: deps.graphUrl, getToken: () => deps.auth.token(SIGN_IN_SCOPES) })
    this.graph = {
      listTree: () => client.listTree(),
      listPages: async (sectionId) => {
        const pages = await client.listPages(sectionId)
        for (const p of pages) pageOrder.set(p.id, p.order)
        return pages
      },
      pageContent: (id) => client.pageContent(id),
      resource: (url) => client.resource(url),
    }
  }

  async tree(): Promise<OneNoteNotebook[]> {
    this.cachedTree = await this.graph.listTree()
    return this.cachedTree
  }

  async start(selectedIds: string[]): Promise<ImportProgress> {
    this.lastPaths = selectionToPaths(this.cachedTree ?? (await this.tree()), new Set(selectedIds))
    return this.run(false)
  }

  retryFailed(): Promise<ImportProgress> {
    return this.run(true)
  }

  cancel(): void {
    this.controller?.abort()
  }

  close(): void {
    this.cancel()
    this.store.close()
  }

  private async run(onlyFailed: boolean): Promise<ImportProgress> {
    if (this.controller) throw new Error('An import is already running')
    const controller = new AbortController()
    this.controller = controller
    try {
      return await runImport({
        graph: this.graph,
        sink: this.sink,
        state: this.sink,
        paths: this.lastPaths,
        onProgress: this.deps.emit,
        signal: controller.signal,
        onlyFailed,
      })
    } finally {
      this.controller = null
    }
  }
}
