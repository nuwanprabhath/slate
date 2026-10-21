import type { PMJSON } from '@slate/core'
import { mapOneNotePage } from './map'
import type { GraphSource, ImportProgress, ImportSink, ImportState, OneNoteNotebook, OneNoteSectionGroup, SectionPath } from './types'

/** Expands the chosen notebooks, groups and sections into the sections to import, in tree order. */
export function selectionToPaths(tree: OneNoteNotebook[], selectedIds: Set<string>): SectionPath[] {
  const out: SectionPath[] = []
  for (const nb of tree) {
    const notebook = { id: nb.id, name: nb.name }
    const nbSelected = selectedIds.has(nb.id)
    for (const section of nb.sections) {
      if (nbSelected || selectedIds.has(section.id)) out.push({ notebook, groups: [], section })
    }
    const walk = (group: OneNoteSectionGroup, chain: SectionPath['groups'], inherited: boolean): void => {
      const groups = [...chain, { id: group.id, name: group.name }]
      const selected = inherited || selectedIds.has(group.id)
      for (const section of group.sections) {
        if (selected || selectedIds.has(section.id)) out.push({ notebook, groups, section })
      }
      for (const child of group.sectionGroups) walk(child, groups, selected)
    }
    for (const group of nb.sectionGroups) walk(group, [], nbSelected)
  }
  return out
}

export interface RunImportOptions {
  graph: GraphSource
  sink: ImportSink
  state: ImportState
  paths: SectionPath[]
  onProgress: (p: ImportProgress) => void
  signal?: AbortSignal
  /** Import only pages whose last attempt failed. */
  onlyFailed?: boolean
}

async function replaceImages(blocks: PMJSON[], swap: (src: string) => Promise<string>): Promise<PMJSON[]> {
  return Promise.all(
    blocks.map(async (b) => {
      const next: PMJSON = { ...b }
      if (b.type === 'image' && typeof b.attrs?.src === 'string') next.attrs = { ...b.attrs, src: await swap(b.attrs.src) }
      if (b.content) next.content = await replaceImages(b.content, swap)
      return next
    })
  )
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function runImport(opts: RunImportOptions): Promise<ImportProgress> {
  const { graph, sink, state, paths, signal } = opts
  const progress: ImportProgress = {
    phase: 'pages',
    sectionsDone: 0,
    sectionsTotal: paths.length,
    pagesDone: 0,
    pagesTotal: 0,
    imported: 0,
    skipped: 0,
    failed: [],
    lossy: []
  }
  const report = (): void => opts.onProgress({ ...progress, failed: [...progress.failed], lossy: [...progress.lossy] })

  for (const path of paths) {
    if (signal?.aborted) break
    const notebookId = await sink.ensureNotebook(path.notebook.id, path.notebook.name)
    let parent: string | null = null
    for (const g of path.groups) parent = await sink.ensureGroup(notebookId, parent, g.id, g.name)
    const sectionId = await sink.ensureSection(notebookId, parent, path.section.id, path.section.name)
    const pages = [...(await graph.listPages(path.section.id))].sort((a, b) => a.order - b.order)
    progress.pagesDone = 0
    progress.pagesTotal = pages.length

    for (const meta of pages) {
      if (signal?.aborted) break
      progress.currentTitle = meta.title
      const prior = await state.get(meta.id)
      const skip = opts.onlyFailed ? prior?.status !== 'failed' : prior?.status === 'done' && prior.lastModified === meta.lastModified
      if (skip) {
        progress.skipped++
      } else {
        try {
          const mapped = mapOneNotePage(await graph.pageContent(meta.id))
          // One upload per distinct resource within a page.
          const blobs = new Map<string, Promise<string>>()
          const swap = (src: string): Promise<string> => {
            let url = blobs.get(src)
            if (!url) {
              url = graph.resource(src).then((r) => sink.putBlob(r.bytes, r.mime))
              blobs.set(src, url)
            }
            return url
          }
          const boxes = await Promise.all(mapped.boxes.map(async (box) => ({ ...box, blocks: await replaceImages(box.blocks, swap) })))
          const title = meta.title || mapped.title
          await sink.writePage(notebookId, sectionId, meta.id, { title, level: meta.level }, { ...mapped, boxes })
          await state.set(meta.id, { lastModified: meta.lastModified, status: 'done' })
          progress.imported++
          if (mapped.lossy.length > 0) progress.lossy.push({ title, items: mapped.lossy })
        } catch (e) {
          const error = message(e)
          await state.set(meta.id, { lastModified: meta.lastModified, status: 'failed', error })
          progress.failed.push({ pageId: meta.id, title: meta.title, error })
        }
      }
      progress.pagesDone++
      report()
    }
    if (signal?.aborted) break
    progress.sectionsDone++
    report()
  }

  progress.phase = signal?.aborted ? 'cancelled' : 'done'
  progress.currentTitle = undefined
  report()
  return progress
}
