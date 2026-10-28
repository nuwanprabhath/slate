import { UndoManager, type LoroDoc } from 'loro-crdt'
import { PageDoc, arrangeBoxes, computePush, hasOverlaps, contentToJSON, settleOverlaps, type BoxPatch, type BoxRect, type BoxState, type PMJSON } from '@slate/core'
import { writeContent } from './content'
import { isEmptyContent } from './emptyBox'
import { schema } from './extensions'
import { findInPage, type FindMatch, type FindOptions } from './find'

export interface DocPersistence {
  load(docId: string): Promise<Uint8Array[]>
  append(docId: string, update: Uint8Array): Promise<void>
}

export const pageDocId = (pageId: string): string => `page:${pageId}`
export const DEFAULT_BOX_WIDTH = 480
/** Edits this close together form one undo step (so an edit and the push it caused undo together). */
const UNDO_MERGE_MS = 500
/** Quiet time after the last height report before an imported page is settled, so the first burst of reports is one settle. */
const SETTLE_DEBOUNCE_MS = 150

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
  private settleTimer: ReturnType<typeof setTimeout> | undefined

  private constructor(readonly pageId: string, page: PageDoc, persistence: DocPersistence) {
    this.page = page
    // sys:* origins are loro-prosemirror's editor initialisation commits; never undo those.
    this.undoManager = new UndoManager(page.doc, { mergeInterval: UNDO_MERGE_MS, excludeOriginPrefixes: ['sys:'] })
    this.snapshot = page.listBoxes()
    this.cleanup.push(page.doc.subscribeLocalUpdates((update) => void persistence.append(pageDocId(pageId), update)))
    this.cleanup.push(
      page.doc.subscribe((batch) => {
        // Event paths are absolute: ['boxes'] or ['boxes', id] is a box added, removed, moved or
        // flagged; anything deeper is text inside a box, which the box editors render themselves.
        if (!batch.events.some((e) => e.path.length <= 2)) return
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

  /** Matches in every box, read from the doc model (static boxes have no editor to search). */
  find(query: string, opts: FindOptions): FindMatch[] {
    return findInPage(this.page, schema, query, opts)
  }

  /** Any change to the page, text inside boxes included. */
  subscribeContent(listener: () => void): () => void {
    return this.doc.subscribe(listener)
  }

  createBox(x: number, y: number, width = DEFAULT_BOX_WIDTH): string {
    return this.page.addBox({ x, y, width })
  }

  createBoxWithContent(x: number, y: number, blocks: PMJSON[], width = DEFAULT_BOX_WIDTH): string {
    const id = this.page.addBox({ x, y, width })
    writeContent(this.page.contentMap(id)!, blocks, this.doc)
    this.doc.commit()
    return id
  }

  /** Removes a box left empty (no text, no image, not private). Returns whether it was removed. */
  deleteIfEmpty(boxId: string): boolean {
    const box = this.page.getBox(boxId)
    const content = this.page.contentMap(boxId)
    if (!box || box.private || !content || !isEmptyContent(contentToJSON(content))) return false
    // sys:* is ignored by the UndoManager: undo must not bring back an empty box.
    this.page.deleteBox(boxId, 'sys:empty')
    return true
  }

  /** A user's delete of a whole box: unlike `deleteIfEmpty` it is an undo step. */
  deleteBox(boxId: string): void {
    this.ownStep(() => this.page.deleteBox(boxId))
  }

  /** Deletes several boxes as one undo step. */
  deleteBoxes(ids: string[]): void {
    if (ids.length > 0) this.ownStep(() => this.page.deleteBoxes(ids))
  }

  /** Moves or resizes boxes as one undo step of their own. */
  updateBoxes(patches: Map<string, BoxPatch>): void {
    if (patches.size > 0) this.ownStep(() => this.page.updateBoxes(patches))
  }

  /**
   * A drag of a box's bottom edge from `oldHeight` to `newHeight`: the new size and the push of the
   * boxes below it (as for growing text) are one undo step.
   */
  resizeBox(boxId: string, patch: BoxPatch, oldHeight: number, newHeight: number): void {
    const moved = computePush(this.rects(), boxId, oldHeight, newHeight)
    const patches = new Map<string, BoxPatch>([[boxId, patch]])
    for (const [id, y] of moved) patches.set(id, { y })
    // The box's own size report after this render is not growth: it was pushed for here.
    this.heights.set(boxId, newHeight)
    this.ownStep(() => this.page.updateBoxes(patches))
  }

  /**
   * Raises a box above the others. Stacking is page data (it syncs and survives a reload) but not
   * an edit: clicking into a box must not add an undo step, so it uses a sys:* origin.
   */
  bringToFront(boxId: string): void {
    this.page.bringToFront(boxId, 'sys:z')
  }

  private rects(): BoxRect[] {
    return this.snapshot.map((b) => ({ id: b.id, x: b.x, y: b.y, width: b.width, height: this.heights.get(b.id) ?? 0 }))
  }

  /** Whether "Re-arrange boxes" would change anything: some boxes overlap. */
  canArrange(): boolean {
    return this.snapshot.length >= 2 && hasOverlaps(this.rects())
  }

  /** "Re-arrange boxes": moves boxes down until none overlap, as one undo step. */
  arrange(): void {
    const moved = arrangeBoxes(this.rects())
    if (moved.size > 0) this.ownStep(() => this.page.moveBoxes(moved))
  }

  /** A change made right after typing would otherwise merge into that edit, and undo would take both back. */
  private ownStep(change: () => void): void {
    this.undoManager.setMergeInterval(0)
    try {
      change()
    } finally {
      this.undoManager.setMergeInterval(UNDO_MERGE_MS)
    }
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
    if (this.page.needsLayout()) this.scheduleSettle()
    if (!local || old === undefined || height <= old) return
    const moved = computePush(this.rects(), boxId, old, height)
    if (moved.size > 0) this.page.moveBoxes(moved)
  }

  /** Imported boxes keep the source app's positions; once all are measured, push overlapping ones down. */
  private scheduleSettle(): void {
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      if (!this.page.needsLayout()) return
      const boxes = this.page.listBoxes()
      if (boxes.some((b) => !this.heights.has(b.id))) return
      const moved = settleOverlaps(boxes.map((b) => ({ id: b.id, x: b.x, y: b.y, width: b.width, height: this.heights.get(b.id)! })))
      // sys:* is ignored by the UndoManager, so undo never un-settles the page.
      if (moved.size > 0) this.page.moveBoxes(moved, 'sys:layout')
    }, SETTLE_DEBOUNCE_MS)
  }

  /** Updates another process wrote; they arrive as `import` events like any remote change. */
  importExternal(updates: Uint8Array[]): void {
    if (updates.length > 0) this.doc.importBatch(updates)
  }

  undo(): boolean {
    return this.undoManager.undo()
  }

  redo(): boolean {
    return this.undoManager.redo()
  }

  close(): void {
    clearTimeout(this.settleTimer)
    if (this.page.needsLayout()) this.page.setNeedsLayout(false)
    this.cleanup.forEach((c) => c())
    this.cleanup = []
    this.listeners.clear()
  }
}
