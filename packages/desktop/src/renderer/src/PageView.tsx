import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NotebookDoc, TreeItem } from '@slate/core'
import { Canvas, type PageSession } from '@slate/editor'
import type { ConflictRecord } from '@slate/sync'
import { currentSession } from './currentSession'
import { FindBar } from './find/FindBar'
import { closePageSession, openPageSession } from './find/notesReplace'
import { ConflictResolver } from './sync/ConflictResolver'

/** Read by the e2e test hooks; cheap enough to keep in production builds. */
export const pageOpenTiming = { startedAt: 0, lastMs: null as number | null }

export function PageView({ nb, item }: { nb: NotebookDoc; item: TreeItem }) {
  const pageId = item.pageId!
  const [session, setSession] = useState<PageSession | null>(null)
  const [title, setTitle] = useState(item.title)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Follow renames from the sidebar, but never fight the user while they type here.
    if (document.activeElement !== titleRef.current) setTitle(item.title)
  }, [item.title])

  useEffect(() => {
    pageOpenTiming.startedAt = performance.now()
    let opened: PageSession | null = null
    let cancelled = false
    void openPageSession(pageId, window.slate.docs).then((s) => {
      if (cancelled) return closePageSession(s)
      opened = s
      currentSession.set(s)
      setSession(s)
    })
    return () => {
      cancelled = true
      if (opened) {
        currentSession.clear(opened)
        closePageSession(opened)
      }
    }
  }, [pageId])

  // What Escape restores: the title as it was when the field took focus.
  const titleOnFocus = useRef('')

  // Time from page selection to the canvas being committed to the DOM (static boxes rendered).
  useLayoutEffect(() => {
    if (session) pageOpenTiming.lastMs = performance.now() - pageOpenTiming.startedAt
  }, [session])

  // Every sync status event may follow a pull that recorded conflicts.
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([])
  const refreshConflicts = useCallback(() => void window.slate.sync.conflicts(`page:${pageId}`).then(setConflicts), [pageId])
  useEffect(() => {
    refreshConflicts()
    return window.slate.sync.onStatus(refreshConflicts)
  }, [refreshConflicts])
  const conflictBoxes = useMemo(() => new Set(conflicts.map((c) => c.boxId)), [conflicts])
  const [resolving, setResolving] = useState<ConflictRecord | null>(null)
  const openConflict = useCallback((boxId: string) => setResolving(conflicts.findLast((c) => c.boxId === boxId) ?? null), [conflicts])
  const closeResolver = useCallback(
    (resolved: boolean) => {
      setResolving(null)
      if (resolved) refreshConflicts()
    },
    [refreshConflicts],
  )

  return (
    <div
      className="page-view"
      // The canvas cancels mousedown's default, which would leave the title focused and swallow the
      // keystrokes meant for the box it just created.
      onMouseDownCapture={(e) => {
        if (e.target !== titleRef.current) titleRef.current?.blur()
      }}
    >
      <input
        ref={titleRef}
        className="page-title"
        data-testid="page-title"
        placeholder="Untitled page"
        spellCheck={false}
        value={title}
        onFocus={() => (titleOnFocus.current = title)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setTitle(titleOnFocus.current)
            nb.setTitle(item.id, titleOnFocus.current)
          } else if (e.key !== 'Enter') return
          e.preventDefault()
          e.currentTarget.blur()
        }}
        onChange={(e) => {
          setTitle(e.target.value)
          nb.setTitle(item.id, e.target.value)
        }}
      />
      {session && <Canvas session={session} conflicts={conflictBoxes} onConflictClick={openConflict} />}
      {session && <FindBar session={session} />}
      {resolving &&<ConflictResolver conflict={resolving} onClose={closeResolver} />}
    </div>
  )
}
