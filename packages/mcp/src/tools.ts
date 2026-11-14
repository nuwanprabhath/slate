import { agentMarkdown, markdownToBlocks, type Access, type TreeItem } from '@slate/core'
import type { AuditOutcome, DocSource, NotebookView } from './source'

/** One message for unknown and forbidden ids alike, so an agent cannot probe what exists. */
export const NOT_PERMITTED = 'not found or not permitted'

/** An audit row names what was asked for, not a whole query: a long one would bloat every row. */
const AUDIT_TARGET_MAX = 200

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
    await src.audit({ tool, target: target.slice(0, AUDIT_TARGET_MAX), outcome: 'ok' })
    return result
  } catch (error) {
    if (error instanceof NotPermitted) await src.audit({ tool, target: target.slice(0, AUDIT_TARGET_MAX), outcome: error.outcome })
    throw error
  }
}

/** Keeps a node if the agent can access it or something inside it. */
function visible(nb: NotebookView, item: TreeItem): AgentTreeItem | null {
  const children = item.children.map((c) => visible(nb, c)).filter((c): c is AgentTreeItem => c !== null)
  const access = nb.access.get(item.id) ?? null
  if (!access && children.length === 0) return null
  return { id: item.id, kind: item.kind, title: item.title, ...(item.pageId ? { pageId: item.pageId } : {}), access, children }
}

function pageIn(items: TreeItem[], pageId: string): TreeItem | undefined {
  for (const item of items) {
    const found = item.kind === 'page' && item.pageId === pageId ? item : pageIn(item.children, pageId)
    if (found) return found
  }
  return undefined
}

async function findPage(src: DocSource, pageId: string, need: Access): Promise<{ ref: NotebookView; item: TreeItem }> {
  for (const ref of await src.notebooks()) {
    const item = pageIn(ref.items, pageId)
    if (!item) continue
    const access = ref.access.get(item.id)
    if (!access || (need === 'readwrite' && access !== 'readwrite')) throw new NotPermitted('denied')
    return { ref, item }
  }
  throw new NotPermitted('not-found')
}

export function listTree(src: DocSource): Promise<AgentNotebook[]> {
  return audited(src, 'list_tree', '*', async () =>
    (await src.notebooks())
      .map((ref) => ({ notebookId: ref.id, name: ref.name, items: ref.items.map((i) => visible(ref, i)).filter((i): i is AgentTreeItem => i !== null) }))
      .filter((nb) => nb.items.length > 0),
  )
}

export function readPage(src: DocSource, pageId: string): Promise<string> {
  return audited(src, 'read_page', pageId, async () => {
    await findPage(src, pageId, 'read')
    return agentMarkdown((await src.readPage(pageId)).boxes)
  })
}

export interface SearchHit {
  notebookId: string
  pageId: string
  title: string
  snippet: string
}

/**
 * Loro frees a decoded doc only once every container handle read from it is gone, and those handles go
 * only in a finalizer task of their own: a search that never yields keeps every page it read (FX-33,
 * about 100 kB a page, enough to exhaust Loro's heap for the whole process). Yielding a macrotask every
 * this many pages lets them go; it matches the DocSource's page cache, so about two caches' worth wait.
 */
const PAGES_PER_TURN = 64
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export function search(src: DocSource, query: string): Promise<SearchHit[]> {
  return audited(src, 'search', query, async () => {
    const needle = query.toLowerCase()
    const hits: SearchHit[] = []
    let read = 0
    for (const ref of await src.notebooks()) {
      const pages: TreeItem[] = []
      const walk = (items: TreeItem[]) => items.forEach((i) => (i.kind === 'page' ? pages.push(i) : walk(i.children)))
      walk(ref.items)
      for (const item of pages) {
        if (!item.pageId || !ref.access.has(item.id)) continue
        if (++read % PAGES_PER_TURN === 0) await nextTurn()
        for (const box of (await src.readPage(item.pageId)).boxes) {
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
    return src.appendBox(pageId, markdownToBlocks(markdown))
  })
}

export function createPage(src: DocSource, notebookId: string, sectionId: string, title: string, markdown?: string): Promise<{ pageId: string }> {
  return audited(src, 'create_page', `${notebookId}/${sectionId}`, async () => {
    // The one notebook write: it needs the live doc, so it borrows it and nothing escapes the callback.
    const made = await src.withNotebook(notebookId, async (nb) => {
      const section = nb.get(sectionId as never)
      if (!section || section.kind !== 'section') throw new NotPermitted('not-found')
      if (nb.effectiveAccess(section.id) !== 'readwrite') throw new NotPermitted('denied')
      const from = nb.doc.oplogVersion()
      const { pageId } = nb.addPage(section.id, title)
      await src.save(`notebook:${notebookId}`, nb.doc.export({ mode: 'update', from }))
      return pageId
    })
    if (made === null) throw new NotPermitted('not-found')
    await src.createPage(made, markdown && markdown.trim() !== '' ? markdownToBlocks(markdown) : null)
    return { pageId: made }
  })
}
