import {
  agentBoxes,
  agentPageMarkdown,
  markdownToBlocks,
  PageDoc,
  placeBelow,
  writeContent,
  type Access,
  type NotebookDoc,
  type TreeItem,
} from '@slate/core'
import type { AuditOutcome, DocSource, NotebookRef } from './source'

/** One message for unknown and forbidden ids alike, so an agent cannot probe what exists. */
export const NOT_PERMITTED = 'not found or not permitted'

class NotPermitted extends Error {
  constructor(readonly outcome: AuditOutcome) {
    super(NOT_PERMITTED)
  }
}

export interface AgentTreeItem {
  id: string
  kind: TreeItem['kind']
  title: string
  pageId?: string
  access: Access | null
  children: AgentTreeItem[]
}

export interface AgentNotebook {
  notebookId: string
  name: string
  items: AgentTreeItem[]
}

async function audited<T>(src: DocSource, tool: string, target: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run()
    await src.audit({ tool, target, outcome: 'ok' })
    return result
  } catch (error) {
    if (error instanceof NotPermitted) await src.audit({ tool, target, outcome: error.outcome })
    throw error
  }
}

/** Keeps a node if the agent can access it or something inside it. */
function visible(nb: NotebookDoc, item: TreeItem): AgentTreeItem | null {
  const children = item.children.map((c) => visible(nb, c)).filter((c): c is AgentTreeItem => c !== null)
  const access = nb.effectiveAccess(item.id)
  if (!access && children.length === 0) return null
  return { id: item.id, kind: item.kind, title: item.title, ...(item.pageId ? { pageId: item.pageId } : {}), access, children }
}

async function findPage(src: DocSource, pageId: string, need: Access): Promise<{ ref: NotebookRef; item: TreeItem }> {
  for (const ref of await src.notebooks()) {
    const item = ref.doc.findPage(pageId)
    if (!item) continue
    const access = ref.doc.effectiveAccess(item.id)
    if (!access || (need === 'readwrite' && access !== 'readwrite')) throw new NotPermitted('denied')
    return { ref, item }
  }
  throw new NotPermitted('not-found')
}

export function listTree(src: DocSource): Promise<AgentNotebook[]> {
  return audited(src, 'list_tree', '*', async () =>
    (await src.notebooks())
      .map((ref) => ({ notebookId: ref.id, name: ref.doc.name, items: ref.doc.items().map((i) => visible(ref.doc, i)).filter((i): i is AgentTreeItem => i !== null) }))
      .filter((nb) => nb.items.length > 0),
  )
}

export function readPage(src: DocSource, pageId: string): Promise<string> {
  return audited(src, 'read_page', pageId, async () => {
    await findPage(src, pageId, 'read')
    return agentPageMarkdown(await src.loadPage(pageId))
  })
}

export interface SearchHit {
  notebookId: string
  pageId: string
  title: string
  snippet: string
}

export function search(src: DocSource, query: string): Promise<SearchHit[]> {
  return audited(src, 'search', query, async () => {
    const needle = query.toLowerCase()
    const hits: SearchHit[] = []
    for (const ref of await src.notebooks()) {
      const pages: TreeItem[] = []
      const walk = (items: TreeItem[]) => items.forEach((i) => (i.kind === 'page' ? pages.push(i) : walk(i.children)))
      walk(ref.doc.items())
      for (const item of pages) {
        if (!item.pageId || !ref.doc.effectiveAccess(item.id)) continue
        for (const box of agentBoxes(await src.loadPage(item.pageId))) {
          if (box.markdown === null) continue
          const at = box.markdown.toLowerCase().indexOf(needle)
          if (at < 0) continue
          hits.push({ notebookId: ref.id, pageId: item.pageId, title: item.title, snippet: box.markdown.slice(Math.max(0, at - 60), at + needle.length + 60) })
          break
        }
      }
    }
    return hits
  })
}

export function appendToPage(src: DocSource, pageId: string, markdown: string): Promise<{ boxId: string }> {
  return audited(src, 'append_to_page', pageId, async () => {
    await findPage(src, pageId, 'readwrite')
    const page = await src.loadPage(pageId)
    const from = page.doc.oplogVersion()
    const { x, y } = placeBelow(page)
    const boxId = page.addBox({ x, y, width: 480 })
    writeContent(page.contentMap(boxId)!, markdownToBlocks(markdown))
    page.doc.commit()
    await src.save(`page:${pageId}`, page.doc.export({ mode: 'update', from }))
    return { boxId }
  })
}

export function createPage(src: DocSource, notebookId: string, sectionId: string, title: string, markdown?: string): Promise<{ pageId: string }> {
  return audited(src, 'create_page', `${notebookId}/${sectionId}`, async () => {
    const ref = (await src.notebooks()).find((n) => n.id === notebookId)
    const section = ref?.doc.get(sectionId as never)
    if (!ref || !section || section.kind !== 'section') throw new NotPermitted('not-found')
    if (ref.doc.effectiveAccess(section.id) !== 'readwrite') throw new NotPermitted('denied')
    const from = ref.doc.doc.oplogVersion()
    const { pageId } = ref.doc.addPage(section.id, title)
    await src.save(`notebook:${notebookId}`, ref.doc.doc.export({ mode: 'update', from }))
    const page = new PageDoc()
    if (markdown && markdown.trim() !== '') {
      const boxId = page.addBox({ x: 40, y: 40, width: 480 })
      writeContent(page.contentMap(boxId)!, markdownToBlocks(markdown))
      page.doc.commit()
    }
    await src.save(`page:${pageId}`, page.doc.export({ mode: 'snapshot' }))
    return { pageId }
  })
}
