import { useEffect, useRef, useState } from 'react'
import type { NotebookDoc, TreeItem } from '@slate/core'
import { Canvas, PageSession } from '@slate/editor'
import { currentSession } from './currentSession'

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
    let opened: PageSession | null = null
    let cancelled = false
    void PageSession.open(pageId, window.slate.docs).then((s) => {
      if (cancelled) return s.close()
      opened = s
      currentSession.set(s)
      setSession(s)
    })
    return () => {
      cancelled = true
      if (opened) {
        currentSession.clear(opened)
        opened.close()
      }
    }
  }, [pageId])

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
        onChange={(e) => {
          setTitle(e.target.value)
          nb.setTitle(item.id, e.target.value)
        }}
      />
      {session && <Canvas session={session} />}
    </div>
  )
}
