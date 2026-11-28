/**
 * "Export everything" (GDPR-05, review §3.5 step 1-2): every notebook as Markdown, every image, the
 * settings, the AI activity record, the sync conflicts and the security log, in a new folder. A folder rather than a zip,
 * so no new dependency. Private boxes are included: this is the person's own copy.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NotebookDoc, PageDoc, toMarkdown, type Access, type PMJSON, type TreeItem } from '@slate/core'
import type { ConflictRecord } from '@slate/sync'
import type { ExportReport, Settings } from '../../shared/api'
import { blobNameFromUrl, type BlobStore } from '../blobs'
import type { AuditRow } from '../store'

export interface ExportedPage {
  id: string
  title: string
  /** Relative to the export folder, with `/` separators. */
  file: string
  access: Access | null
  images: string[]
}

export interface ExportManifest {
  format: 'slate-export'
  version: 1
  exportedAt: string
  appVersion: string
  notebooks: Array<{
    id: string
    name: string
    sections: Array<{ id: string; title: string; access: Access | null; pages: ExportedPage[] }>
  }>
  /** Page documents no notebook lists (left by an interrupted move or sync); exported so nothing is held back. */
  unfiled: ExportedPage[]
  /** What could not be exported, by id or file name only; the export carries on past each. */
  errors: Array<{ item: string; reason: string }>
}

export interface ExportSource {
  store: { list(prefix: string): string[]; load(docId: string): Uint8Array[]; listAudit(limit: number): AuditRow[]; listConflicts(): ConflictRecord[] }
  blobs: Pick<BlobStore, 'list' | 'has' | 'read'>
  settings: Settings
  /** The security log's text; throws when it cannot be read (listed in `errors`). */
  securityLog: () => string
  appVersion: string
  now: Date
}

/**
 * Each table the export carries, with the file or folder (relative to the export) it goes to. PRIVACY.md's retention
 * table says "exported" for exactly these and why each other table is not (tools/guards/privacyNotice.test.ts).
 */
export const EXPORTED_TABLES = {
  snapshots: 'notebooks',
  updates: 'notebooks',
  settings: 'settings.json',
  blob_data: 'images',
  audit: 'ai-audit.json',
  conflicts: 'conflicts.json',
} as const

/** The most AI activity rows the store keeps (store.ts prunes to this). */
const AUDIT_ROWS = 10_000
const MAX_NAME = 80
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** A file or folder name from a title: `[A-Za-z0-9 ._-]` only, no leading dot, at most 80 characters. */
export function safeName(title: string): string {
  const cleaned = title
    .replace(/[^A-Za-z0-9 ._-]/g, '_')
    .replace(/^[\s.]+/, '')
    .slice(0, MAX_NAME)
    .trimEnd()
  return cleaned === '' ? 'Untitled' : cleaned
}

/** Hands out `safeName`s unique within one folder (case-insensitively, for macOS and Windows): `Name`, `Name-2`, … */
function namer(): (title: string) => string {
  const used = new Set<string>()
  return (title) => {
    const base = safeName(title)
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, MAX_NAME - String(n).length - 1)}-${String(n)}`
    used.add(name.toLowerCase())
    return name
  }
}

/** The folder name: `Slate export 2026-11-26T10-30-00Z` (no colons, which Windows refuses and Finder shows as `/`). */
export function exportFolderName(now: Date): string {
  return `Slate export ${now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}`
}

/** A copy of `node` with each note image pointing into the export's `images/` folder; the names it found go in `found`. */
function relinkImages(node: PMJSON, imagesPrefix: string, found: Set<string>): PMJSON {
  const src = node.type === 'image' && typeof node.attrs?.src === 'string' ? node.attrs.src : null
  const name = src === null ? null : blobNameFromUrl(src)
  if (name) found.add(name)
  return {
    ...node,
    ...(name && node.attrs ? { attrs: { ...node.attrs, src: imagesPrefix + name } } : {}),
    ...(node.content ? { content: node.content.map((c) => relinkImages(c, imagesPrefix, found)) } : {}),
  }
}

/** The page as Markdown: its title, then each box in reading order (top to bottom, then left to right). */
export function pageMarkdown(parts: Uint8Array[], title: string, imagesPrefix: string): { markdown: string; images: string[] } {
  const page = PageDoc.fromUpdates(parts)
  try {
    const found = new Set<string>()
    const boxes = page.listBoxes().sort((a, b) => a.y - b.y || a.x - b.x)
    const blocks: string[] = [`# ${title.replace(/\s+/g, ' ').trim() || 'Untitled page'}`]
    for (const box of boxes) {
      const json = page.boxContent(box.id)
      if (!json) continue
      const md = toMarkdown([relinkImages(json, imagesPrefix, found)])
      if (md.trim() !== '') blocks.push(md)
    }
    return { markdown: `${blocks.join('\n\n')}\n`, images: [...found] }
  } finally {
    page.doc.free()
  }
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Writes the export into a new folder inside `parent`. Refuses (throws) when that folder already
 * exists: an export never overwrites anything. Files are 0600 and folders 0700.
 */
export async function writeExport(parent: string, src: ExportSource): Promise<ExportReport & { manifest: ExportManifest }> {
  const folder = join(parent, exportFolderName(src.now))
  // Not recursive: an existing folder is EEXIST, and the parent must be the one the person chose.
  await mkdir(folder, { mode: DIR_MODE })
  let bytes = 0
  const write = async (rel: string[], data: string | Uint8Array): Promise<void> => {
    await writeFile(join(folder, ...rel), data, { mode: FILE_MODE, flag: 'wx' })
    bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
  }
  const dir = (rel: string[]) => mkdir(join(folder, ...rel), { recursive: true, mode: DIR_MODE })
  const manifest: ExportManifest = { format: 'slate-export', version: 1, exportedAt: src.now.toISOString(), appVersion: src.appVersion, notebooks: [], unfiled: [], errors: [] }
  const exported = new Set<string>()
  let pages = 0

  const exportPage = async (pageId: string, title: string, access: Access | null, rel: string[], fileName: (t: string) => string): Promise<ExportedPage | null> => {
    const docId = `page:${pageId}`
    exported.add(docId)
    try {
      const file = `${fileName(`${title}-${pageId.slice(0, 8)}`)}.md`
      const { markdown, images } = pageMarkdown(src.store.load(docId), title, '../'.repeat(rel.length) + 'images/')
      await dir(rel)
      await write([...rel, file], markdown)
      pages++
      return { id: pageId, title, file: [...rel, file].join('/'), access, images }
    } catch (e) {
      manifest.errors.push({ item: docId, reason: reasonOf(e) })
      return null
    }
  }

  const notebookNames = namer()
  for (const docId of src.store.list('notebook:')) {
    const id = docId.slice('notebook:'.length)
    let nb: NotebookDoc
    try {
      nb = NotebookDoc.fromUpdates(src.store.load(docId))
    } catch (e) {
      manifest.errors.push({ item: docId, reason: reasonOf(e) })
      continue
    }
    try {
      const entry: ExportManifest['notebooks'][number] = { id, name: nb.name, sections: [] }
      const nbDir = notebookNames(nb.name)
      const sectionNames = namer()
      const sections: TreeItem[] = []
      const collect = (items: TreeItem[]) => {
        for (const item of items) {
          if (item.kind === 'section') sections.push(item)
          else if (item.kind === 'sectionGroup') collect(item.children)
        }
      }
      collect(nb.items())
      for (const section of sections) {
        const rel = ['notebooks', nbDir, sectionNames(section.title)]
        const fileNames = namer()
        const out: ExportedPage[] = []
        const walk = async (items: TreeItem[]) => {
          for (const item of items) {
            if (item.kind === 'page' && item.pageId) {
              const page = await exportPage(item.pageId, item.title, item.access, rel, fileNames)
              if (page) out.push(page)
            }
            await walk(item.children)
          }
        }
        await walk(section.children)
        entry.sections.push({ id: section.id, title: section.title, access: section.access, pages: out })
      }
      manifest.notebooks.push(entry)
    } finally {
      nb.doc.free()
    }
  }

  const unfiledNames = namer()
  for (const docId of src.store.list('page:')) {
    if (exported.has(docId)) continue
    const page = await exportPage(docId.slice('page:'.length), 'Unfiled page', null, ['unfiled'], unfiledNames)
    if (page) manifest.unfiled.push(page)
  }

  let images = 0
  const stored = src.blobs.list()
  if (stored.length > 0) await dir(['images'])
  for (const name of stored) {
    try {
      await write(['images', name], src.blobs.read(name))
      images++
    } catch (e) {
      manifest.errors.push({ item: `images/${name}`, reason: reasonOf(e) })
    }
  }
  const referenced = new Set([...manifest.notebooks.flatMap((n) => n.sections.flatMap((s) => s.pages)), ...manifest.unfiled].flatMap((p) => p.images))
  for (const name of referenced) if (!src.blobs.has(name)) manifest.errors.push({ item: `images/${name}`, reason: 'A page shows this image, but it is not stored on this device.' })

  await write(['settings.json'], `${JSON.stringify(src.settings, null, 2)}\n`)
  await write(['ai-audit.json'], `${JSON.stringify(src.store.listAudit(AUDIT_ROWS), null, 2)}\n`)
  await write(['conflicts.json'], `${JSON.stringify(src.store.listConflicts(), null, 2)}\n`)
  try {
    await write(['security-log.txt'], src.securityLog())
  } catch (e) {
    manifest.errors.push({ item: 'security-log.txt', reason: reasonOf(e) })
  }
  await write(['manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`)
  return { folder, pages, images, bytes, manifest }
}
