import { memo, useEffect, type CSSProperties, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { BoxPatch, BoxState } from '@slate/core'
import type { EditorView } from '@tiptap/pm/view'
import { BoxEditor } from './BoxEditor'
import { boxContentDragged, dropInEmptySpace } from './dragMove'
import { selectFromEmptySpace } from './emptySpace'
import { findStore } from './find'
import type { PageSession } from './PageSession'
import { StaticBox } from './StaticBox'

const MIN_WIDTH = 120
/** Border top and bottom: a stored min height is the box's outer height. */
const BORDERS = 2

/** Edges and corners a box can be resized from (compass points; the top edge is the handle). */
export type ResizeEdge = 'e' | 'w' | 's' | 'se' | 'sw'
const EDGES: ReadonlyArray<{ edge: ResizeEdge; testId: string }> = [
  { edge: 'e', testId: 'box-resize' },
  { edge: 'w', testId: 'box-resize-left' },
  { edge: 's', testId: 'box-resize-bottom' },
  { edge: 'se', testId: 'box-resize-se' },
  { edge: 'sw', testId: 'box-resize-sw' },
]

export interface GroupDrag {
  dx: number
  dy: number
}

interface Props {
  box: BoxState
  session: PageSession
  scrollRoot: HTMLElement
  autoFocus: boolean
  onFocus: (id: string) => void
  conflict?: boolean
  onConflictClick?: (id: string) => void
  /** Position in the page's stacking order, 1 = back. */
  layer: number
  /** The handle lies over another box: draw it always, so what catches the pointer there is visible. */
  handleShown: boolean
  /** In the Cmd/Ctrl+click multi-selection. */
  selected: boolean
  /** Every pointer press on the box; returns true when the canvas consumed it (a Cmd/Ctrl+click). */
  onPress: (id: string, e: ReactPointerEvent<HTMLElement>) => boolean
  /** Dragging a selected box's handle moves the whole selection; the canvas owns that gesture. */
  onGroupDrag: (drag: GroupDrag | null, commit: boolean) => void
  /** The selection's live offset while one of its handles is dragged. */
  groupDrag: GroupDrag | null
  /** Marked by Mod+X: the next paste moves it. */
  cut: boolean
  /** A press and release on the handle without moving: selects the box. */
  onHandleClick: (id: string) => void
}

type Gesture = { x: number; y: number; width: number; height?: number }

function BoxImpl({ box, session, scrollRoot, autoFocus, onFocus: onFocusBox, conflict, onConflictClick, layer, selected, handleShown, onPress, onGroupDrag, groupDrag, cut, onHandleClick }: Props) {
  const onFocus = () => {
    session.bringToFront(box.id)
    onFocusBox(box.id)
  }
  const ref = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const editorView = () => bodyRef.current?.querySelector<HTMLElement & { editor?: { view: EditorView } }>('.ProseMirror')?.editor?.view
  const [visible, setVisible] = useState(false)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  // Static boxes have no decorations, so a box with find matches is a live editor while they show.
  const findHit = useSyncExternalStore(findStore.subscribe, () => findStore.hasMatches(box.id))

  useEffect(() => {
    const io = new IntersectionObserver((entries) => setVisible(entries[0]?.isIntersecting ?? false), { root: scrollRoot, rootMargin: '600px 0px' })
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
  useEffect(() => setGesture(null), [box.x, box.y, box.width, box.height])

  /** Height of the content alone: a min height may never go below it. */
  const contentHeight = (): number => {
    const body = bodyRef.current
    if (!body) return 0
    let h = 0
    for (const child of Array.from(body.children)) if (child instanceof HTMLElement) h += child.offsetHeight
    return h + BORDERS
  }

  const startGesture = (e: ReactPointerEvent<HTMLElement>, mode: 'move' | ResizeEdge) => {
    e.preventDefault()
    e.stopPropagation()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const group = mode === 'move' && selected
    const minHeight = mode === 'move' ? 0 : contentHeight()
    const startHeight = ref.current?.offsetHeight ?? box.height ?? minHeight
    const start = { px: e.clientX, py: e.clientY, x: box.x, y: box.y, width: box.width }
    let current: Gesture = { x: start.x, y: start.y, width: start.width, height: box.height }
    let groupDelta: GroupDrag = { dx: 0, dy: 0 }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px
      const dy = ev.clientY - start.py
      if (group) {
        groupDelta = { dx, dy }
        onGroupDrag(groupDelta, false)
        return
      }
      if (mode === 'move') current = { ...current, x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) }
      else {
        const next: Gesture = { ...current }
        if (mode === 'e' || mode === 'se') next.width = Math.max(MIN_WIDTH, start.width + dx)
        if (mode === 'w' || mode === 'sw') {
          // The right edge stays put: x and width change together, within the minimum width and the canvas.
          const shift = Math.max(-start.x, Math.min(dx, start.width - MIN_WIDTH))
          next.x = start.x + shift
          next.width = start.width - shift
        }
        if (mode === 's' || mode === 'se' || mode === 'sw') next.height = Math.max(minHeight, startHeight + dy)
        current = next
      }
      setGesture(current)
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      if (group) {
        onGroupDrag(groupDelta, true)
        if (groupDelta.dx === 0 && groupDelta.dy === 0) onHandleClick(box.id)
        return
      }
      const patch: BoxPatch = { x: Math.round(current.x), y: Math.round(current.y), width: Math.round(current.width) }
      // Dragged back to the content's own height: no min height, so the box shrinks with its text again.
      if (current.height !== undefined) patch.height = current.height <= minHeight + 1 ? null : Math.round(current.height)
      if (patch.x === box.x && patch.y === box.y && patch.width === box.width && (patch.height === undefined || (patch.height ?? undefined) === box.height)) {
        setGesture(null)
        if (mode === 'move') onHandleClick(box.id)
        return
      }
      if (patch.height !== undefined) session.resizeBox(box.id, patch, startHeight, Math.max(minHeight, current.height ?? 0))
      else {
        // A width change reflows the text; growth from that pushes boxes below, as typing does.
        if (mode !== 'move') session.noteLocalEdit(box.id)
        session.updateBoxes(new Map([[box.id, patch]]))
      }
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  // The handle has focus only after a click on it, never while the caret is in the text, so these keys cannot eat text.
  const onHandleKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== 'Escape') return
    e.preventDefault()
    e.currentTarget.closest<HTMLElement>('.slate-canvas')?.focus()
    if (e.key !== 'Escape') session.deleteBox(box.id)
  }

  const shown = gesture ?? box
  const x = shown.x + (selected && groupDrag ? groupDrag.dx : 0)
  const y = shown.y + (selected && groupDrag ? groupDrag.dy : 0)
  const style = { left: Math.max(0, x), top: Math.max(0, y), width: shown.width, minHeight: shown.height, '--z': layer } as CSSProperties
  return (
    <div
      ref={ref}
      className={['slate-box', box.private && 'is-private', conflict && 'has-conflict', selected && 'is-selected', cut && 'is-cut', handleShown && 'handle-shown'].filter(Boolean).join(' ')}
      data-testid="box"
      data-box-id={box.id}
      aria-selected={selected}
      style={style}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return
        if (onPress(box.id, e)) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        session.bringToFront(box.id)
      }}
    >
      <div className="slate-box-bar">
        <div className="slate-box-handle" data-testid="box-handle" tabIndex={-1}
          onPointerDown={(e) => {
            // startGesture's preventDefault would stop the click focusing the handle.
            e.currentTarget.focus()
            startGesture(e, 'move')
          }}
          onKeyDown={onHandleKey}
        />
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
      <div
        className="slate-box-body"
        ref={bodyRef}
        onMouseDown={(e) => {
          // Only the body's own empty space: the editor, its image handles and the bar handle their presses.
          if (e.button !== 0 || e.target !== e.currentTarget) return
          const view = editorView()
          if (!view) return
          e.preventDefault()
          selectFromEmptySpace(view, e.clientX, e.clientY, e.shiftKey)
        }}
        // A picture or text dropped in the body's empty space lands at the nearest text, as a click there does.
        onDragOver={(e) => {
          if (e.target === e.currentTarget && boxContentDragged()) e.preventDefault()
        }}
        onDrop={(e) => {
          if (e.target !== e.currentTarget) return
          const view = editorView()
          if (view && dropInEmptySpace(view, e.clientX, e.clientY, e.nativeEvent, session)) e.preventDefault()
        }}
      >
        {visible || autoFocus || findHit ? (
          <BoxEditor box={box} session={session} autoFocus={autoFocus} onFocus={onFocus} />
        ) : (
          <StaticBox doc={session.doc} contentId={box.contentId} onActivate={onFocus} />
        )}
      </div>
      {EDGES.map(({ edge, testId }) => (
        <div key={edge} className={`slate-box-resize slate-box-resize-${edge}`} data-testid={testId} onPointerDown={(e) => startGesture(e, edge)} />
      ))}
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
    a.box.height === b.box.height &&
    a.layer === b.layer &&
    a.selected === b.selected &&
    a.handleShown === b.handleShown &&
    a.cut === b.cut &&
    a.onHandleClick === b.onHandleClick &&
    a.onPress === b.onPress &&
    a.onGroupDrag === b.onGroupDrag &&
    (a.selected ? a.groupDrag === b.groupDrag : true) &&
    a.box.contentId === b.box.contentId,
)
