import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BoxState } from '@slate/core'
import { BoxEditor } from './BoxEditor'
import type { PageSession } from './PageSession'
import { StaticBox } from './StaticBox'

const MIN_WIDTH = 120

interface Props {
  box: BoxState
  session: PageSession
  scrollRoot: HTMLElement
  autoFocus: boolean
  onFocus: () => void
}

type Gesture = { x: number; y: number; width: number }

export function Box({ box, session, scrollRoot, autoFocus, onFocus }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [gesture, setGesture] = useState<Gesture | null>(null)

  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: scrollRoot, rootMargin: '600px 0px' })
    io.observe(ref.current!)
    return () => io.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => session.reportHeight(box.id, el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [session, box.id])

  // Drop the local gesture override once the doc reflects the committed position.
  useEffect(() => setGesture(null), [box.x, box.y, box.width])

  const startGesture = (e: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
    e.preventDefault()
    e.stopPropagation()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const start = { px: e.clientX, py: e.clientY, x: box.x, y: box.y, width: box.width }
    let current: Gesture = { x: start.x, y: start.y, width: start.width }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px
      const dy = ev.clientY - start.py
      current =
        mode === 'move'
          ? { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy), width: start.width }
          : { x: start.x, y: start.y, width: Math.max(MIN_WIDTH, start.width + dx) }
      setGesture(current)
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      if (mode === 'resize') session.noteLocalEdit(box.id)
      session.page.updateBox(box.id, { x: Math.round(current.x), y: Math.round(current.y), width: Math.round(current.width) })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  const { x, y, width } = gesture ?? box
  return (
    <div ref={ref} className="slate-box" data-testid="box" data-box-id={box.id} style={{ left: x, top: y, width }}>
      <div className="slate-box-bar">
        <div className="slate-box-handle" data-testid="box-handle" onPointerDown={(e) => startGesture(e, 'move')} />
      </div>
      {visible || autoFocus ? (
        <BoxEditor box={box} session={session} autoFocus={autoFocus} onFocus={onFocus} />
      ) : (
        <StaticBox doc={session.doc} contentId={box.contentId} onActivate={onFocus} />
      )}
      <div className="slate-box-resize" data-testid="box-resize" onPointerDown={(e) => startGesture(e, 'resize')} />
    </div>
  )
}
