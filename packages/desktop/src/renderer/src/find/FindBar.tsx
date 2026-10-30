import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { compileQuery, findMatches, findStore, type FindMatch, type FindOptions, type PageSession } from '@slate/editor'
import { currentToReplace } from './currentMatch'
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
  /** The replace row is shown (the ▸ toggle). */
  replaceOpen: boolean
  replacement: string
  preserveCase: boolean
  /** Bumped by the replace shortcut, so the replace field takes focus. */
  replaceFocusCount: number
}

export interface FindTarget {
  pageId: string
  boxId: string
  /** The match's index within its box. */
  occurrence: number
}

// Module state, so the query and options outlive the PageView (switching pages) for the session.
let state: BarState = {
  open: false,
  query: '',
  opts: { matchCase: false, wholeWord: false, regex: false },
  openCount: 0,
  target: null,
  replaceOpen: false,
  replacement: '',
  preserveCase: false,
  replaceFocusCount: 0,
}
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
  /** Opens with the replace row shown and its field focused (Mod+Alt+F on macOS, Ctrl+H elsewhere). */
  openReplace(): void {
    findBar.open()
    update({ replaceOpen: true, replaceFocusCount: state.replaceFocusCount + 1 })
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

/** The replace field's toggle, shared with the Search view's replace field. */
export const PRESERVE_CASE = { code: 'KeyP', label: 'AB', title: 'Preserve Case (Alt+P)' }

/** The replace shortcut: VS Code's, Mod+Alt+F on macOS (Cmd+H hides the app there), Ctrl+H elsewhere. */
export const isReplaceKey = (e: KeyboardEvent | ReactKeyboardEvent): boolean =>
  navigator.platform.startsWith('Mac') ? e.metaKey && e.altKey && !e.shiftKey && e.code === 'KeyF' : e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyH'

/** The ▸ / ▾ that shows the replace row, as in VS Code. */
export function ReplaceToggle({ open, onToggle, testId }: { open: boolean; onToggle: () => void; testId: string }) {
  return (
    <button
      type="button"
      className="find-replace-toggle"
      data-testid={testId}
      title="Toggle Replace"
      aria-label="Toggle Replace"
      aria-expanded={open}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={open ? { transform: 'rotate(90deg)' } : undefined}>
        <path d="M6 4l4 4-4 4" />
      </svg>
    </button>
  )
}

/** VS Code-style find widget for the page on screen; mounted by PageView, so a new page searches afresh. */
export function FindBar({ session }: { session: PageSession }) {
  const { open, query, opts, openCount, replaceOpen, replacement, preserveCase, replaceFocusCount } = useSyncExternalStore(findBar.subscribe, findBar.get)
  const [matches, setMatches] = useState<FindMatch[]>([])
  const [current, setCurrent] = useState(0)
  const handledReplaceFocus = useRef(state.replaceFocusCount)
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)

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
    if (open) (findBar.get().replaceFocusCount > handledReplaceFocus.current ? replaceRef : inputRef).current?.select()
    handledReplaceFocus.current = findBar.get().replaceFocusCount
  }, [open, openCount, replaceFocusCount])

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
      } else if (isReplaceKey(e)) {
        e.preventDefault()
        findBar.openReplace()
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

  const togglePreserveCase = () => update({ preserveCase: !preserveCase })
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const t = TOGGLES.find((x) => x.code === e.code)
    if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
    else if (e.key === 'Escape') findBar.close()
    else if (e.altKey && !isMod(e) && t) toggle(t.key)
    else if (e.altKey && !isMod(e) && e.code === PRESERVE_CASE.code) togglePreserveCase()
    else return
    e.preventDefault()
  }

  const replaceCurrent = () => {
    const fresh = session.find(query, opts)
    const target = currentToReplace(matches, index, fresh)
    // Stale highlights: show the page's matches as they are now, and let the user press again.
    if (!target) return setMatches(fresh)
    session.replace(query, opts, replacement, { preserveCase, only: (boxId, n) => boxId === target.boxId && n === target.occurrence })
    // The next match slides into this place, unless the replacement is itself a match: step past it.
    if (!opts.regex) setCurrent(index + findMatches(replacement, query, opts).length)
  }
  const replaceAll = () => {
    if (matches.length > 0) session.replace(query, opts, replacement, { preserveCase })
  }
  const onReplaceKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && isMod(e)) replaceAll()
    else if (e.key === 'Enter') replaceCurrent()
    else if (e.key === 'Escape') findBar.close()
    else if (e.altKey && !isMod(e) && e.code === PRESERVE_CASE.code) togglePreserveCase()
    else if (e.altKey && !isMod(e) && TOGGLES.some((x) => x.code === e.code)) toggle(TOGGLES.find((x) => x.code === e.code)!.key)
    else return
    e.preventDefault()
  }

  return (
    <div className="find-bar" data-testid="find-bar" data-popup role="search" onMouseDown={(e) => e.stopPropagation()}>
      <ReplaceToggle open={replaceOpen} testId="find-replace-toggle" onToggle={() => update({ replaceOpen: !replaceOpen })} />
      <div className="find-rows">
        <div className="find-row">
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
        {replaceOpen && (
          <div className="find-row">
            <ReplaceField
              inputRef={replaceRef}
              testId="replace"
              value={replacement}
              preserveCase={preserveCase}
              onChange={(value) => update({ replacement: value })}
              onTogglePreserveCase={togglePreserveCase}
              onKeyDown={onReplaceKeyDown}
            />
            <button type="button" className="btn find-action" data-testid="replace-one" title="Replace (Enter)" disabled={index < 0} onMouseDown={(e) => e.preventDefault()} onClick={replaceCurrent}>
              Replace
            </button>
            <button type="button" className="btn find-action" data-testid="replace-all" title={`Replace All (${isMac ? '⌘' : 'Ctrl+'}Enter)`} disabled={index < 0} onMouseDown={(e) => e.preventDefault()} onClick={replaceAll}>
              Replace All
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

/** The replace field with its Preserve Case toggle, as the find field holds its option toggles. */
export function ReplaceField(props: {
  className?: string
  inputRef?: RefObject<HTMLInputElement | null>
  testId: string
  value: string
  preserveCase: boolean
  onChange: (value: string) => void
  onTogglePreserveCase: () => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void
}) {
  return (
    <div className={props.className ? `find-input ${props.className}` : 'find-input'}>
      <input
        ref={props.inputRef}
        data-testid={`${props.testId}-input`}
        aria-label="Replace"
        placeholder="Replace"
        spellCheck={false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={props.onKeyDown}
      />
      <button
        type="button"
        className="find-toggle"
        data-testid={`${props.testId}-preserveCase`}
        title={PRESERVE_CASE.title}
        aria-label={PRESERVE_CASE.title}
        aria-pressed={props.preserveCase}
        onMouseDown={(e) => e.preventDefault()}
        onClick={props.onTogglePreserveCase}
      >
        {PRESERVE_CASE.label}
      </button>
    </div>
  )
}
