import { useEffect, useState } from 'react'
import { Canvas, PageSession } from '@slate/editor'
import { currentSession } from './currentSession'

export function PageView({ pageId }: { pageId: string }) {
  const [session, setSession] = useState<PageSession | null>(null)
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
  return <div className="page-view">{session && <Canvas session={session} />}</div>
}
