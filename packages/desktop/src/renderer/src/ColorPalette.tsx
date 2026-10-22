import { useEffect, useRef, useState, type ReactNode } from 'react'
import { STANDARD_COLORS, themeGrid } from '@slate/core'
import { ChevronIcon } from './toolbarIcons'
import './colorPalette.css'

const THEME = themeGrid()
const RECENT_MAX = 10

function readRecent(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function writeRecent(key: string, colors: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(colors))
  } catch {
    // Storage can be unavailable; recents then last only for this session.
  }
}

interface Props {
  /** Test id and storage name: `tb-${id}` and `tb-${id}-menu`. */
  id: 'color' | 'highlight'
  label: string
  autoLabel: string
  defaultColor: string
  disabled: boolean
  icon: (color: string) => ReactNode
  /** Applies a colour, or removes it for null. The caller refocuses the editor. */
  onPick: (color: string | null) => void
}

/**
 * A split button with OneNote's colour popover. The editor keeps focus the whole time (every
 * mousedown is prevented, and the keys are read at the document while the popover is open), so
 * picking a colour applies to the selection the user made.
 */
export function ColorPalette({ id, label, autoLabel, defaultColor, disabled, icon, onPick }: Props) {
  const storageKey = `slate.recentColors.${id}`
  const [recent, setRecent] = useState(() => readRecent(storageKey))
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const last = recent[0] ?? defaultColor

  const sections: string[][] = [STANDARD_COLORS, ...THEME]
  const auto = '__auto__'
  const items: string[] = [...sections.flat(), auto, ...recent]

  const pick = (color: string | null) => {
    setOpen(false)
    if (color) {
      const next = [color, ...recent.filter((c) => c !== color)].slice(0, RECENT_MAX)
      setRecent(next)
      writeRecent(storageKey, next)
    }
    onPick(color)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -10, ArrowDown: 10 }[e.key]
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'Enter' && cursor >= 0) pick(items[cursor] === auto ? null : items[cursor]!)
      else if (step !== undefined) setCursor((c) => Math.min(items.length - 1, Math.max(0, c < 0 ? 0 : c + step)))
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  })

  let index = 0
  const swatch = (color: string, key: string) => {
    const i = index++
    return (
      <button
        key={key}
        type="button"
        className={i === cursor ? 'palette-swatch kb' : 'palette-swatch'}
        data-testid="palette-swatch"
        data-color={color}
        title={color}
        aria-label={color}
        style={{ background: color }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(color)}
      />
    )
  }

  return (
    <div className="color-palette" ref={root}>
      <button
        type="button"
        data-testid={`tb-${id}`}
        title={label}
        aria-label={label}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(last)}
      >
        {icon(last)}
      </button>
      <button
        type="button"
        className="chevron"
        data-testid={`tb-${id}-menu`}
        title={`${label} options`}
        aria-label={`${label} options`}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setCursor(-1)
          setOpen(!open)
        }}
      >
        <ChevronIcon />
      </button>
      {open && (
        <div className="palette-popover" role="dialog" aria-label={label} data-testid={`palette-${id}`}>
          <div className="palette-heading">Standard Colours</div>
          <div className="palette-row">{STANDARD_COLORS.map((c) => swatch(c, `s${c}`))}</div>
          <div className="palette-heading">Theme Colours</div>
          <div className="palette-grid">{THEME.map((row, r) => row.map((c, k) => swatch(c, `t${r}-${k}`)))}</div>
          {(() => {
            const i = index++
            return (
              <button
                type="button"
                className={i === cursor ? 'palette-auto kb' : 'palette-auto'}
                data-testid="palette-auto"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(null)}
              >
                {autoLabel}
              </button>
            )
          })()}
          {recent.length > 0 && (
            <>
              <div className="palette-heading">Recent Colours</div>
              <div className="palette-row" data-testid="palette-recent">
                {recent.map((c) => swatch(c, `r${c}`))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
