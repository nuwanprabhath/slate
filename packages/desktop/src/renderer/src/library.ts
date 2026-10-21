import { NotebookDoc, newId } from '@slate/core'
import { pageDocId } from '@slate/editor'
import type { SlateApi } from '../../shared/api'

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

  static async load(api: SlateApi): Promise<Library> {
    const library = new Library(api)
    for (const docId of await api.docs.list('notebook:')) {
      library.attach(docId.slice('notebook:'.length), NotebookDoc.fromUpdates(await api.docs.load(docId)))
    }
    if (library.entries.length === 0) library.createNotebook('My Notebook')
    return library
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

  /** Agents cannot create notebooks, so updates for an unknown one are ignored. */
  importExternal(notebookId: string, updates: Uint8Array[]): void {
    const entry = this.entries.find((e) => e.id === notebookId)
    if (entry && updates.length > 0) entry.doc.doc.importBatch(updates)
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
