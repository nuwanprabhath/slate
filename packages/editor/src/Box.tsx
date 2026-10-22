import { memo, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import type { BoxState } from '@slate/core'
import { BoxEditor } from './BoxEditor'
import { findStore } from './find'
import type { PageSession } from './PageSession'
import { StaticBox } from './StaticBox'

const MIN_WIDTH = 120

interface Props {
  box: BoxState
  session: PageSession
  scrollRoot: HTMLElement
  autoFocus: boolean
  onFocus: (id: string) => void
  conflict?: boolean
  onConflictClick?: (id: string) => void
}

type Gesture = { x: number; y: number; width: number }

function BoxImpl({ box, session, scrollRoot, autoFocus, onFocus: onFocusBox, conflict, onConflictClick }: Props) {
  const onFocus = () => onFocusBox(box.id)
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  // Static boxes have no decorations, so a box with find matches is a live editor while they show.
  const findHit = useSyncExternalStore(findStore.subscribe, () => findStore.hasMatches(box.id))

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
    <div ref={ref} className={['slate-box', box.private && 'is-private', conflict && 'has-conflict'].filter(Boolean).join(' ')} data-testid="box" data-box-id={box.id} style={{ left: x, top: y, width }}>
      <div className="slate-box-bar">
        <div className="slate-box-handle" data-testid="box-handle" onPointerDown={(e) => startGesture(e, 'move')} />
        {conflict && (
          <button
            type="button"
            className="slate-box-conflict"
            data-testid="conflict-chip"
            title="Edits from another device were merged here. Review them."
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onConflictClick?.(box.id)}
          >
            merged edits
          </button>
        )}
        <button
          type="button"
          className="slate-box-lock"
          data-testid="box-lock"
          aria-pressed={box.private}
          title={box.private ? 'Private: hidden from AI agents — click to share' : 'Visible to AI agents — click to make private'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => session.page.updateBox(box.id, { private: !box.private })}
        >
          {/* Open: the shackle is lifted and swung right, so the gap reads as unlocked at a glance. */}
          <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="2" y="6.5" width="8" height="6" rx="1" fill="currentColor" />
            <path
              d={box.private ? 'M3.75 6.5V4.5a2.25 2.25 0 0 1 4.5 0v2' : 'M8.25 4V2.75a2.25 2.25 0 0 1 4.5 0V5'}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      {visible || autoFocus || findHit ? (
        <BoxEditor box={box} session={session} autoFocus={autoFocus} onFocus={onFocus} />
      ) : (
        <StaticBox doc={session.doc} contentId={box.contentId} onActivate={onFocus} />
      )}
      <div className="slate-box-resize" data-testid="box-resize" onPointerDown={(e) => startGesture(e, 'resize')} />
    </div>
  )
}

// Every doc change hands the canvas fresh BoxState objects, so compare by value: typing in one box
// must not re-render the other 199.
export const Box = memo(
  BoxImpl,
  (a, b) =>
    a.session === b.session &&
    a.scrollRoot === b.scrollRoot &&
    a.autoFocus === b.autoFocus &&
    a.onFocus === b.onFocus &&
    a.conflict === b.conflict &&
    a.onConflictClick === b.onConflictClick &&
    a.box.id === b.box.id &&
    a.box.x === b.box.x &&
    a.box.y === b.box.y &&
    a.box.width === b.box.width &&
    a.box.private === b.box.private &&
    a.box.contentId === b.box.contentId,
)
