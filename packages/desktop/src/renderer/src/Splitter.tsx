import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { COLUMN_DEFAULT, COLUMN_MAX, COLUMN_MIN } from './layout'

const KEY_STEP = 16

interface Props {
  testId: string
  label: string
  /** Width of the column to the left of this splitter. */
  width: number
  onChange: (width: number) => void
}

export function Splitter({ testId, label, width, onChange }: Props) {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, width: 0 })

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, width }
    setDragging(true)
    document.body.classList.add('resizing-columns')
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    document.body.classList.remove('resizing-columns')
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) onChange(start.current.width + e.clientX - start.current.x)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onChange(width - KEY_STEP)
    else if (e.key === 'ArrowRight') onChange(width + KEY_STEP)
    else return
    e.preventDefault()
  }

  return (
    <div
      className={dragging ? 'splitter dragging' : 'splitter'}
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={COLUMN_MIN}
      aria-valuemax={COLUMN_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(COLUMN_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  )
}
