import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { compileQuery, findStore, type FindMatch, type FindOptions, type PageSession } from '@slate/editor'
import './find.css'

/** Quiet time after a page edit before the search re-runs. */
const CONTENT_DEBOUNCE_MS = 100

interface BarState {
  open: boolean
  query: string
  opts: FindOptions
  /** Bumped on every open, so a second Cmd+F refocuses and selects the input. */
  openCount: number
  /** The match to make current once that page's matches are in (from a Find in Notes result). */
  target: FindTarget | null
}

export interface FindTarget {
  pageId: string
  boxId: string
  /** The match's index within its box. */
  occurrence: number
}

// Module state, so the query and options outlive the PageView (switching pages) for the session.
let state: BarState = { open: false, query: '', opts: { matchCase: false, wholeWord: false, regex: false }, openCount: 0, target: null }
let returnFocus: HTMLElement | null = null
const listeners = new Set<() => void>()
const update = (patch: Partial<BarState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export const findBar = {
  get: (): BarState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  open(): void {
    const active = document.activeElement
    if (!active?.closest('.find-bar')) returnFocus = active instanceof HTMLElement ? active : null
    const sel = window.getSelection()
    const selected = sel && !sel.isCollapsed && sel.anchorNode?.parentElement?.closest('.slate-box') ? sel.toString() : ''
    update({ open: true, openCount: state.openCount + 1, ...(selected && !selected.includes('\n') ? { query: selected } : {}) })
  },
  /** Opens pre-filled, e.g. from a search result; `target` picks the current match on its page. */
  openWith(query: string, opts: FindOptions, target: FindTarget | null = null): void {
    returnFocus = null
    update({ open: true, query, opts, target, openCount: state.openCount + 1 })
  },
  close(): void {
    update({ open: false })
    if (returnFocus?.isConnected) returnFocus.focus()
    returnFocus = null
  },
}

const isMod = (e: KeyboardEvent | ReactKeyboardEvent) => (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey)

/** The input's option toggles, shared with the Search view's input. */
export const TOGGLES: Array<{ key: keyof FindOptions; code: string; label: string; title: string }> = [
  { key: 'matchCase', code: 'KeyC', label: 'Aa', title: 'Match Case (Alt+C)' },
  { key: 'wholeWord', code: 'KeyW', label: 'ab', title: 'Match Whole Word (Alt+W)' },
  { key: 'regex', code: 'KeyR', label: '.*', title: 'Use Regular Expression (Alt+R)' },
]

/** VS Code-style find widget for the page on screen; mounted by PageView, so a new page searches afresh. */
export function FindBar({ session }: { session: PageSession }) {
  const { open, query, opts, openCount } = useSyncExternalStore(findBar.subscribe, findBar.get)
  const [matches, setMatches] = useState<FindMatch[]>([])
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return setMatches([])
    const run = () => setMatches(session.find(query, opts))
    run()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = session.subscribeContent(() => {
      clearTimeout(timer)
      timer = setTimeout(run, CONTENT_DEBOUNCE_MS)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [session, open, query, opts, openCount])

  useEffect(() => setCurrent(0), [query, opts])
  // After the reset above, so a target from Find in Notes wins over match 0.
  useEffect(() => {
    const target = findBar.get().target
    if (!target || target.pageId !== session.pageId || matches.length === 0) return
    const inBox = matches.flatMap((m, i) => (m.boxId === target.boxId ? [i] : []))
    if (inBox.length > 0) setCurrent(inBox[Math.min(target.occurrence, inBox.length - 1)]!)
    update({ target: null })
  }, [session, matches])
  const index = matches.length === 0 ? -1 : Math.min(current, matches.length - 1)

  useEffect(() => {
    findStore.setMatches(matches, index)
    if (index < 0) return
    // Two frames: a static box with a match turns into a live editor before its decorations exist.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => document.querySelector('.slate-find-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    })
    return () => cancelAnimationFrame(frame)
  }, [matches, index])
  useEffect(() => () => findStore.setMatches([], -1), [])

  useLayoutEffect(() => {
    if (open) inputRef.current?.select()
  }, [open, openCount])

  const step = (delta: number) => {
    if (matches.length > 0) setCurrent((index + delta + matches.length) % matches.length)
  }
  const stepRef = useRef(step)
  stepRef.current = step

  // Fallback for the menu accelerator, and Cmd/Ctrl+G or F3 from anywhere while the bar is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isMod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        findBar.open()
      } else if (findBar.get().open && ((isMod(e) && e.key.toLowerCase() === 'g') || e.key === 'F3')) {
        e.preventDefault()
        stepRef.current(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  if (!open) return null
  const invalid = opts.regex && query !== '' && compileQuery(query, opts) === null
  const toggle = (key: keyof FindOptions) => update({ opts: { ...opts, [key]: !opts[key] } })

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const t = TOGGLES.find((x) => x.code === e.code)
    if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
    else if (e.key === 'Escape') findBar.close()
    else if (e.altKey && !isMod(e) && t) toggle(t.key)
    else return
    e.preventDefault()
  }

  return (
    <div className="find-bar" data-testid="find-bar" role="search" onMouseDown={(e) => e.stopPropagation()}>
      <div className={invalid ? 'find-input has-error' : 'find-input'}>
        <input
          ref={inputRef}
          data-testid="find-input"
          aria-label="Find"
          aria-invalid={invalid}
          placeholder="Find"
          spellCheck={false}
          value={query}
          onChange={(e) => update({ query: e.target.value })}
          onKeyDown={onKeyDown}
        />
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            type="button"
            className="find-toggle"
            data-testid={`find-${t.key}`}
            title={t.title}
            aria-label={t.title}
            aria-pressed={opts[t.key]}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <span className="find-count" data-testid="find-count">
        {index < 0 ? 'No results' : `${index + 1} of ${matches.length}`}
      </span>
      <button type="button" className="find-button" data-testid="find-prev" title="Previous Match (Shift+Enter)" aria-label="Previous Match" disabled={matches.length === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" className="find-button" data-testid="find-next" title="Next Match (Enter)" aria-label="Next Match" disabled={matches.length === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" className="find-button" data-testid="find-close" title="Close (Escape)" aria-label="Close" onClick={() => findBar.close()}>
        ×
      </button>
    </div>
  )
}
