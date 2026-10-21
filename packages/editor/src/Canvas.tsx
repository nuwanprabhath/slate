import { useEffect, useState, useSyncExternalStore, type MouseEvent } from 'react'
import type { PMJSON } from '@slate/core'
import { Box } from './Box'
import { imageFilesFrom } from './images'
import type { PageSession } from './PageSession'
import { useEditorServices } from './services'
import './canvas.css'

interface CanvasProps {
  session: PageSession
  /** Boxes whose edits were merged with another device's: they show a "merged edits" chip. */
  conflicts?: Set<string>
  onConflictClick?: (boxId: string) => void
}

export function Canvas({ session, conflicts, onConflictClick }: CanvasProps) {
  const boxes = useSyncExternalStore(session.subscribe, session.getBoxes)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const services = useEditorServices()

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.slate-box, input, textarea, [contenteditable="true"]')) return
      const top = (scrollRoot?.scrollTop ?? 0) + 40
      const files = imageFilesFrom(e.clipboardData)
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (files.length === 0 && text.trim() === '') return
      e.preventDefault()
      void (async () => {
        const blocks: PMJSON[] =
          files.length > 0
            ? await Promise.all(files.map(async (f) => ({ type: 'image', attrs: { src: await services.putBlob(new Uint8Array(await f.arrayBuffer()), f.type) } })))
            : text.replace(/\r\n?/g, '\n').split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] }))
        session.createBoxWithContent(40, top, blocks)
      })()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [session, services, scrollRoot])

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.button !== 0) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    setFocusId(session.createBox(Math.max(0, Math.round(e.clientX - rect.left)), Math.max(0, Math.round(e.clientY - rect.top))))
  }

  const bottom = boxes.reduce((max, b) => Math.max(max, b.y + (session.heightOf(b.id) ?? 0)), 0)
  const right = boxes.reduce((max, b) => Math.max(max, b.x + b.width), 0)
  return (
    <div className="slate-scroll" ref={setScrollRoot} data-testid="canvas-scroll">
      <div className="slate-canvas" data-testid="canvas" style={{ minHeight: bottom + 400, minWidth: right + 200 }} onMouseDown={onMouseDown}>
        {scrollRoot &&
          boxes.map((b) => (
            <Box
              key={b.id}
              box={b}
              session={session}
              scrollRoot={scrollRoot}
              autoFocus={b.id === focusId}
              onFocus={setFocusId}
              conflict={conflicts?.has(b.id) ?? false}
              onConflictClick={onConflictClick}
            />
          ))}
      </div>
    </div>
  )
}
