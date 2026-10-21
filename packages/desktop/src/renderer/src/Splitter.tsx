import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { COLUMN_MAX, COLUMN_MIN, fitWidth, type MeasuredRow } from './layout'

const KEY_STEP = 16

const px = (value: string) => parseFloat(value) || 0

/** Horizontal space an element's padding, gaps and children (except `skip`) take. */
function chromeOf(row: HTMLElement, skip?: Element | null): number {
  const style = getComputedStyle(row)
  const kids = Array.from(row.children).filter((c) => c !== skip) as HTMLElement[]
  const gaps = Math.max(0, row.children.length - 1) * px(style.columnGap)
  return px(style.paddingLeft) + px(style.paddingRight) + gaps + kids.reduce((sum, c) => sum + c.offsetWidth, 0)
}

function measureColumn(root: HTMLElement, ctx: CanvasRenderingContext2D): number {
  const rows: MeasuredRow[] = []
  for (const row of root.querySelectorAll<HTMLElement>('.tree-row')) {
    const name = row.querySelector<HTMLElement>('.label') ?? row.querySelector<HTMLInputElement>('.inline-rename')
    if (!name) continue
    ctx.font = getComputedStyle(name).font
    const isInput = name instanceof HTMLInputElement
    // An inline rename input has its own padding and border around the text.
    const text = ctx.measureText(isInput ? name.value : (name.textContent ?? '')).width + (isInput ? 12 : 0)
    // +1 of slack so sub-pixel rounding never clips the last letter.
    rows.push({ text, chrome: chromeOf(row, name) + 1 })
  }
  const actions = root.querySelector<HTMLElement>('.sidebar-actions')
  // The footer stacks its buttons, so it needs room for the widest one.
  const footer = actions ? px(getComputedStyle(actions).paddingLeft) * 2 + Math.max(0, ...Array.from(actions.children, (c) => (c as HTMLElement).offsetWidth)) + 1 : 0
  return fitWidth(rows, footer)
}

interface ColumnProps {
  testId: string
  /** Manual width, or `null` to fit the longest name. */
  width: number | null
  children: ReactNode
}

/** A library column that sizes itself to its widest entry unless the user dragged a width. */
export function Column({ testId, width, children }: ColumnProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [fitted, setFitted] = useState(COLUMN_MIN)

  useLayoutEffect(() => {
    const root = ref.current
    const ctx = document.createElement('canvas').getContext('2d')
    if (!root || !ctx) return
    const measure = () => setFitted(measureColumn(root, ctx))
    measure()
    // Renames, adds, deletes and section/notebook switches all change the subtree.
    const observer = new MutationObserver(measure)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="column" data-testid={testId} style={{ width: width ?? fitted }}>
      {children}
    </div>
  )
}

interface Props {
  testId: string
  label: string
  /** Manual width of the column to the left, or `null` while it fits its content. */
  width: number | null
  /** `null` (double-click) hands the column back to auto-fit. */
  onChange: (width: number | null) => void
}

export function Splitter({ testId, label, width, onChange }: Props) {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, width: 0 })
  // The column to the left may be auto-fitted, so its rendered width is the drag/keyboard origin.
  const columnWidth = (el: HTMLElement) => el.previousElementSibling?.getBoundingClientRect().width ?? width ?? COLUMN_MIN

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, width: columnWidth(e.currentTarget) }
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
    const current = columnWidth(e.currentTarget)
    if (e.key === 'ArrowLeft') onChange(current - KEY_STEP)
    else if (e.key === 'ArrowRight') onChange(current + KEY_STEP)
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
      aria-valuenow={width ?? undefined}
      aria-valuemin={COLUMN_MIN}
      aria-valuemax={COLUMN_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(null)}
      onKeyDown={onKeyDown}
    />
  )
}
