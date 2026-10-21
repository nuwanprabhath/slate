import { useState, useSyncExternalStore, type MouseEvent } from 'react'
import { Box } from './Box'
import type { PageSession } from './PageSession'
import './canvas.css'

export function Canvas({ session }: { session: PageSession }) {
  const boxes = useSyncExternalStore(session.subscribe, session.getBoxes)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)

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
            <Box key={b.id} box={b} session={session} scrollRoot={scrollRoot} autoFocus={b.id === focusId} onFocus={() => setFocusId(b.id)} />
          ))}
      </div>
    </div>
  )
}
