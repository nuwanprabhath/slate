import type { PMJSON } from '@slate/core'

// Shared contract between the OneNote mapping, the Graph client, the import engine and the
// desktop app's sink. Changing a shape here changes all four.

export interface OneNoteSection {
  id: string
  name: string
  lastModified: string
}

export interface OneNoteSectionGroup {
  id: string
  name: string
  sectionGroups: OneNoteSectionGroup[]
  sections: OneNoteSection[]
}

export interface OneNoteNotebook {
  id: string
  name: string
  sectionGroups: OneNoteSectionGroup[]
  sections: OneNoteSection[]
}

export interface OneNotePageMeta {
  id: string
  title: string
  /** OneNote subpage level, 0–2. */
  level: number
  /** Position within the section. */
  order: number
  lastModified: string
}

/** One absolutely positioned OneNote element, as a Slate box. */
export interface MappedBox {
  x: number
  y: number
  width: number
  /** Image nodes carry the OneNote resource URL in `attrs.src` until the engine replaces it with a blob URL. */
  blocks: PMJSON[]
}

export interface MappedPage {
  title: string
  boxes: MappedBox[]
  /** Human-readable descriptions of what could not be imported faithfully (ink, attachments, embeds). */
  lossy: string[]
}

/** What the engine needs from Microsoft Graph (real client or a test fake). */
export interface GraphSource {
  listTree(): Promise<OneNoteNotebook[]>
  listPages(sectionId: string): Promise<OneNotePageMeta[]>
  pageContent(pageId: string): Promise<string>
  resource(url: string): Promise<{ bytes: Uint8Array; mime: string }>
}

/** Where a selected section lives in its notebook. */
export interface SectionPath {
  notebook: { id: string; name: string }
  groups: Array<{ id: string; name: string }>
  section: OneNoteSection
}

/** Writes Slate documents. The desktop app implements it over SQLite; tests use memory. */
export interface ImportSink {
  /** Returns the Slate notebook id, creating the notebook the first time this OneNote notebook is imported. */
  ensureNotebook(onenoteId: string, name: string): Promise<string>
  /** Returns the tree id of the Slate section group, creating it if needed. */
  ensureGroup(notebookId: string, parentGroupTreeId: string | null, onenoteId: string, name: string): Promise<string>
  /** Returns the tree id of the Slate section, creating it if needed. */
  ensureSection(notebookId: string, parentGroupTreeId: string | null, onenoteId: string, name: string): Promise<string>
  /** Creates or replaces the Slate page for this OneNote page. Image srcs are already blob URLs. */
  writePage(notebookId: string, sectionTreeId: string, onenotePageId: string, meta: { title: string; level: number }, page: MappedPage): Promise<void>
  putBlob(bytes: Uint8Array, mime: string): Promise<string>
}

export interface ImportRecord {
  lastModified: string
  status: 'done' | 'failed'
  error?: string
}

/** Checkpoints per OneNote page, so an interrupted or repeated import skips finished pages. */
export interface ImportState {
  get(onenotePageId: string): Promise<ImportRecord | undefined>
  set(onenotePageId: string, record: ImportRecord): Promise<void>
}

export interface ImportProgress {
  phase: 'pages' | 'done' | 'cancelled'
  sectionsDone: number
  sectionsTotal: number
  pagesDone: number
  pagesTotal: number
  currentTitle?: string
  imported: number
  skipped: number
  failed: Array<{ pageId: string; title: string; error: string }>
  lossy: Array<{ title: string; items: string[] }>
}
