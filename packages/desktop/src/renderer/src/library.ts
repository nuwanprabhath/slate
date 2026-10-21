import { NotebookDoc, newId } from '@slate/core'
import { pageDocId } from '@slate/editor'
import type { SlateApi, SyncState } from '../../shared/api'

/**
 * Whether a waiting device has heard all it will from sync: a sync reached the drive this session,
 * or sync can no longer run (turned off, signed out).
 */
export const syncSettled = (s: SyncState): boolean =>
  (s.status === 'idle-synced' && s.lastSyncedAt !== undefined) || s.status === 'disabled' || s.status === 'signed-out'

export const notebookDocId = (id: string): string => `notebook:${id}`

export interface NotebookEntry {
  id: string
  doc: NotebookDoc
  detach: () => void
}

/** All notebooks on this device, persisted through window.slate.docs. */
export class Library {
  private entries: NotebookEntry[] = []
  private listeners = new Set<() => void>()
  private version = 0

  private constructor(private readonly api: SlateApi) {}

  /** Loads the stored notebooks. It may come back empty: see `settle` for the default notebook. */
  static async load(api: SlateApi): Promise<Library> {
    const library = new Library(api)
    await library.loadUnknown()
    return library
  }

  isEmpty(): boolean {
    return this.entries.length === 0
  }

  /**
   * Called once nothing more is coming (sync off at start-up, or the first sync done): picks up
   * notebooks that landed in the store meanwhile, and only then creates the default, so a newly
   * synced device does not add an empty "My Notebook" to every device.
   */
  async settle(): Promise<void> {
    await this.loadUnknown()
    if (this.entries.length === 0) this.createNotebook('My Notebook')
  }

  private async loadUnknown(): Promise<void> {
    let added = false
    for (const docId of await this.api.docs.list('notebook:')) {
      const id = docId.slice('notebook:'.length)
      if (this.entries.some((e) => e.id === id)) continue
      const parts = await this.api.docs.load(docId)
      if (parts.length === 0 || this.entries.some((e) => e.id === id)) continue
      this.attach(id, NotebookDoc.fromUpdates(parts))
      added = true
    }
    if (added) this.bump()
  }

  notebooks(): NotebookEntry[] {
    return [...this.entries].sort((a, b) => a.doc.name.localeCompare(b.doc.name))
  }

  createNotebook(name: string): NotebookEntry {
    const entry = this.attach(newId(), new NotebookDoc())
    entry.doc.rename(name)
    const section = entry.doc.addSection('Quick Notes')
    entry.doc.addPage(section, 'Untitled page')
    this.bump()
    return entry
  }

  async deleteNotebook(id: string): Promise<void> {
    const index = this.entries.findIndex((e) => e.id === id)
    if (index < 0) return
    const [entry] = this.entries.splice(index, 1)
    entry.detach()
    const pageIds = entry.doc.allPageIds()
    if (this.entries.length === 0) this.createNotebook('My Notebook')
    this.bump()
    await this.removePageDocs(pageIds)
    await this.api.docs.remove(notebookDocId(id))
  }

  async removePageDocs(pageIds: string[]): Promise<void> {
    await Promise.all(pageIds.map((p) => this.api.docs.remove(pageDocId(p))))
  }

  /**
   * Updates for an unknown notebook mean the importer created it: load it whole. Batches that
   * arrive while it loads are already in the database, so the first load to finish includes them
   * and the others drop out.
   */
  importExternal(notebookId: string, updates: Uint8Array[]): void {
    const entry = this.entries.find((e) => e.id === notebookId)
    if (entry && updates.length > 0) entry.doc.doc.importBatch(updates)
    if (!entry)
      void this.api.docs.load(notebookDocId(notebookId)).then((parts) => {
        if (parts.length === 0 || this.entries.some((e) => e.id === notebookId)) return
        this.attach(notebookId, NotebookDoc.fromUpdates(parts))
        this.bump()
      })
  }

  getVersion =(): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private attach(id: string, doc: NotebookDoc): NotebookEntry {
    const offUpdates = doc.doc.subscribeLocalUpdates((u) => void this.api.docs.append(notebookDocId(id), u))
    const offChanges = doc.doc.subscribe(() => this.bump())
    const entry = { id, doc, detach: () => (offUpdates(), offChanges()) }
    this.entries.push(entry)
    return entry
  }

  private bump(): void {
    this.version++
    this.listeners.forEach((l) => l())
  }
}
