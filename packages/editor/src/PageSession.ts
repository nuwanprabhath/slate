import { UndoManager, type LoroDoc } from 'loro-crdt'
import { PageDoc, computePush, type BoxState, type PMJSON } from '@slate/core'
import { writeContent } from './content'

export interface DocPersistence {
  load(docId: string): Promise<Uint8Array[]>
  append(docId: string, update: Uint8Array): Promise<void>
}

export const pageDocId = (pageId: string): string => `page:${pageId}`
export const DEFAULT_BOX_WIDTH = 480
/** Edits this close together form one undo step (so an edit and the push it caused undo together). */
const UNDO_MERGE_MS = 500

/** One open page: its Loro doc, page-wide undo, persistence and auto-push. */
export class PageSession {
  readonly page: PageDoc
  readonly undoManager: UndoManager
  private snapshot: BoxState[]
  private listeners = new Set<() => void>()
  private heights = new Map<string, number>()
  /** Boxes whose latest content change was the user's own; only their growth pushes others. */
  private localEdits = new Set<string>()
  private cleanup: Array<() => void> = []

  private constructor(readonly pageId: string, page: PageDoc, persistence: DocPersistence) {
    this.page = page
    // sys:* origins are loro-prosemirror's editor initialisation commits; never undo those.
    this.undoManager = new UndoManager(page.doc, { mergeInterval: UNDO_MERGE_MS, excludeOriginPrefixes: ['sys:'] })
    this.snapshot = page.listBoxes()
    this.cleanup.push(page.doc.subscribeLocalUpdates((update) => void persistence.append(pageDocId(pageId), update)))
    this.cleanup.push(
      page.doc.subscribe(() => {
        this.snapshot = page.listBoxes()
        this.listeners.forEach((l) => l())
      }),
    )
  }

  static async open(pageId: string, persistence: DocPersistence): Promise<PageSession> {
    return new PageSession(pageId, PageDoc.fromUpdates(await persistence.load(pageDocId(pageId))), persistence)
  }

  get doc(): LoroDoc {
    return this.page.doc
  }

  getBoxes = (): BoxState[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  createBox(x: number, y: number, width = DEFAULT_BOX_WIDTH): string {
    return this.page.addBox({ x, y, width })
  }

  createBoxWithContent(x: number, y: number, blocks: PMJSON[], width = DEFAULT_BOX_WIDTH): string {
    const id = this.page.addBox({ x, y, width })
    writeContent(this.page.contentMap(id)!, blocks)
    this.doc.commit()
    return id
  }

  noteLocalEdit(boxId: string): void {
    this.localEdits.add(boxId)
  }

  /** A remote import, undo/redo or initial load changed the box: its next growth must not push. */
  noteRemoteEdit(boxId: string): void {
    this.localEdits.delete(boxId)
  }

  heightOf(boxId: string): number | undefined {
    return this.heights.get(boxId)
  }

  reportHeight(boxId: string, height: number): void {
    const old = this.heights.get(boxId)
    this.heights.set(boxId, height)
    // Event-based, not time-based: on a slow machine the resize can arrive long after the edit.
    const local = this.localEdits.delete(boxId)
    if (!local || old === undefined || height <= old) return
    const rects = this.snapshot.map((b) => ({ id: b.id, x: b.x, y: b.y, width: b.width, height: this.heights.get(b.id) ?? 0 }))
    const moved = computePush(rects, boxId, old, height)
    if (moved.size > 0) this.page.moveBoxes(moved)
  }

  undo(): boolean {
    return this.undoManager.undo()
  }

  redo(): boolean {
    return this.undoManager.redo()
  }

  close(): void {
    this.cleanup.forEach((c) => c())
    this.cleanup = []
    this.listeners.clear()
  }
}
