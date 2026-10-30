import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { compileQuery, expandReplacement, type FindOptions } from '@slate/editor'
import type { SearchMatch, SearchPageResult, SearchResults } from '../../../../shared/api'
import { PRESERVE_CASE, ReplaceField, ReplaceToggle, TOGGLES } from '../../find/FindBar'
import type { PluginContext, SlatePlugin } from '../types'
import { confirmText, replaceRequest, tickKey } from './replacePlan'
import { effectiveScope, resolveScope, summaryText, type StoredScope } from './scope'
import './search.css'

const TYPE_DEBOUNCE_MS = 200
const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

interface SearchState {
  query: string
  opts: FindOptions
  scope: StoredScope | undefined
  results: SearchResults | null
  collapsed: ReadonlySet<string>
  /** Bumped by Cmd/Ctrl+Shift+F; the panel focuses its input when it sees a new value. */
  focusCount: number
  replaceOpen: boolean
  replacement: string
  preserveCase: boolean
  /** Replace All…'s preview: the matches unticked (`pageId\nindex`); null when not previewing. */
  preview: { unticked: ReadonlySet<string> } | null
  replacing: boolean
  /** Bumped after a replace, so the search runs again on the changed pages. */
  searchCount: number
}

/** Outlives the panel (switching to Notebooks and back keeps the query and results). */
function createStore() {
  let state: SearchState = {
    query: '',
    opts: { matchCase: false, wholeWord: false, regex: false },
    scope: undefined,
    results: null,
    collapsed: new Set(),
    focusCount: 0,
    replaceOpen: false,
    replacement: '',
    preserveCase: false,
    preview: null,
    replacing: false,
    searchCount: 0,
  }
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    update(patch: Partial<SearchState>) {
      state = { ...state, ...patch }
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}
type Store = ReturnType<typeof createStore>

/** A magnifier. */
function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.25 12.25 16.5 16.5" />
    </svg>
  )
}

export function createSearchPlugin(): SlatePlugin {
  return {
    id: 'search',
    name: 'Search',
    activate(ctx) {
      const store = createStore()
      void ctx.settings.get<StoredScope>('scope').then((scope) => {
        if (scope && store.get().scope === undefined) store.update({ scope })
      })
      ctx.views.register({ id: 'search', title: 'Search', icon: <SearchIcon />, order: 10, shortcut: isMac ? '⇧⌘F' : 'Ctrl+Shift+F', render: () => <SearchPanel ctx={ctx} store={store} /> })
      ctx.commands.register({
        id: 'search.open',
        title: 'Find in Notes',
        keybinding: 'Mod+Shift+F',
        run: () => {
          ctx.views.show('search')
          store.update({ focusCount: store.get().focusCount + 1 })
        },
      })
    },
  }
}

type Row = { kind: 'page'; page: SearchPageResult } | { kind: 'match'; page: SearchPageResult; match: SearchMatch; index: number }

function Snippet({ match, replaceWith }: { match: SearchMatch; replaceWith?: (snippet: string, from: number, to: number) => string }) {
  const parts: Array<{ text: string; hit: boolean; from: number }> = []
  let at = 0
  for (const [from, to] of match.ranges) {
    if (from > at) parts.push({ text: match.snippet.slice(at, from), hit: false, from: at })
    parts.push({ text: match.snippet.slice(from, to), hit: true, from })
    at = to
  }
  if (at < match.snippet.length) parts.push({ text: match.snippet.slice(at), hit: false, from: at })
  return (
    <span className="search-snippet" title={match.snippet}>
      {parts.map((p, i) =>
        !p.hit ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : replaceWith ? (
          <Fragment key={i}>
            <del>{p.text}</del>
            <ins>{replaceWith(match.snippet, p.from, p.from + p.text.length)}</ins>
          </Fragment>
        ) : (
          <mark key={i}>{p.text}</mark>
        ),
      )}
    </span>
  )
}

function SearchPanel({ ctx, store }: { ctx: PluginContext; store: Store }) {
  const { query, opts, scope, results, collapsed, focusCount, replaceOpen, replacement, preserveCase, preview, replacing, searchCount } = useSyncExternalStore(store.subscribe, store.get)
  const inputRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const handledFocus = useRef(-1)
  const [active, setActive] = useState(0)
  const library = ctx.app.getLibrary()
  const currentNotebookId = ctx.app.currentNotebookId()
  const shown = effectiveScope(scope, library, currentNotebookId)
  const queryScope = resolveScope(scope, library, currentNotebookId)
  const scopeKey = JSON.stringify(queryScope)
  const invalid = opts.regex && query !== '' && compileQuery(query, opts) === null

  useLayoutEffect(() => {
    if (handledFocus.current === focusCount) return
    handledFocus.current = focusCount
    if (focusCount > 0) inputRef.current?.select()
  }, [focusCount])

  useEffect(() => {
    // New results end a preview: its ticks were for the old ones.
    if (query === '' || invalid) return store.update({ results: null, preview: null })
    let stale = false
    const timer = setTimeout(() => {
      void ctx.app.search({ text: query, ...opts, scope: JSON.parse(scopeKey) }).then((r) => {
        if (!stale) store.update({ results: r, preview: null })
      })
    }, TYPE_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [ctx, store, query, opts, scopeKey, invalid, searchCount])

  const rows: Row[] = []
  for (const page of results?.pages ?? []) {
    rows.push({ kind: 'page', page })
    if (!collapsed.has(page.pageId)) page.matches.forEach((match, index) => rows.push({ kind: 'match', page, match, index }))
  }
  const activeRow = Math.min(active, rows.length - 1)

  const toggle = (key: keyof FindOptions) => store.update({ opts: { ...opts, [key]: !opts[key] } })
  const setScope = (value: string) => {
    const next: StoredScope = value === 'all' ? { kind: 'all' } : value === 'notebook' ? { kind: 'notebook' } : { kind: 'section', id: value.slice('section:'.length) }
    store.update({ scope: next })
    void ctx.settings.set('scope', next)
  }
  const toggleGroup = (pageId: string) => {
    const next = new Set(collapsed)
    if (!next.delete(pageId)) next.add(pageId)
    store.update({ collapsed: next })
  }
  const open = (row: Row) => {
    if (row.kind === 'page') return toggleGroup(row.page.pageId)
    ctx.app.openPage(row.page.pageId, { highlight: { query, options: opts, boxId: row.match.boxId, occurrence: row.match.occurrence } })
  }

  const re = invalid ? null : compileQuery(query, opts)
  const replaceWith = preview && re ? (text: string, from: number, to: number) => expandReplacement(text, from, to, re, replacement, opts, preserveCase) : undefined
  const request = preview && results ? replaceRequest(results, preview.unticked, { query, opts, replacement, preserveCase }) : null
  const startPreview = () => {
    if (results && results.total > 0 && !invalid) store.update({ preview: { unticked: new Set() } })
  }
  const setTicks = (keys: string[], ticked: boolean) => {
    if (!preview) return
    const next = new Set(preview.unticked)
    for (const k of keys) {
      if (ticked) next.delete(k)
      else next.add(k)
    }
    store.update({ preview: { unticked: next } })
  }
  const confirm = () => {
    if (!request || request.pages.length === 0 || replacing) return
    store.update({ replacing: true })
    void ctx.app
      .replaceInPages(request)
      .finally(() => store.update({ replacing: false, preview: null, searchCount: store.get().searchCount + 1 }))
  }
  const onReplaceKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') startPreview()
    else if (e.key === 'Escape' && preview) store.update({ preview: null })
    else if (e.altKey && !(isMac ? e.metaKey : e.ctrlKey) && e.code === PRESERVE_CASE.code) store.update({ preserveCase: !preserveCase })
    else return
    e.preventDefault()
  }

  const clear = () => {
    store.update({ query: '', results: null })
    inputRef.current?.focus()
  }
  const onInputKey =(e: ReactKeyboardEvent<HTMLInputElement>) => {
    const t = TOGGLES.find((x) => x.code === e.code)
    if (e.key === 'ArrowDown' && rows.length > 0) {
      setActive(0)
      treeRef.current?.focus()
    } else if (e.key === 'Escape' && query !== '') clear()
    else if (e.altKey && !(isMac ? e.metaKey : e.ctrlKey) && t) toggle(t.key)
    else return
    e.preventDefault()
  }
  const onTreeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive(Math.min(activeRow + 1, rows.length - 1))
    else if (e.key === 'ArrowUp') {
      if (activeRow === 0) inputRef.current?.focus()
      else setActive(activeRow - 1)
    } else if (e.key === 'Enter' && rows[activeRow]) open(rows[activeRow])
    else return
    e.preventDefault()
  }
  useEffect(() => {
    treeRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeRow])

  const sections = library.find((nb) => nb.id === currentNotebookId)?.sections ?? []
  const scopeValue = shown.kind === 'section' ? `section:${shown.id}` : shown.kind

  return (
    <aside className="sidebar search-panel" data-testid="search-panel">
      <div className="search-header">Search</div>
      <div className="search-inputs">
        <ReplaceToggle open={replaceOpen} testId="search-replace-toggle" onToggle={() => store.update({ replaceOpen: !replaceOpen, preview: null })} />
        <div className="search-input-rows">
          <div className={invalid ? 'find-input search-input has-error' : 'find-input search-input'}>
            <input
              ref={inputRef}
              data-testid="search-input"
              aria-label="Search notes"
              aria-invalid={invalid}
              placeholder="Search"
              spellCheck={false}
              value={query}
              onChange={(e) => store.update({ query: e.target.value })}
              onKeyDown={onInputKey}
            />
            {query !== '' && (
              <button type="button" className="search-clear" data-testid="search-clear" title="Clear search" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={clear}>
                ✕
              </button>
            )}
            {TOGGLES.map((t) => (
              <button
                key={t.key}
                type="button"
                className="find-toggle"
                data-testid={`search-${t.key}`}
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
          {replaceOpen && (
            <div className="search-replace-row">
              <ReplaceField
                className="search-replace-field"
                testId="search-replace"
                value={replacement}
                preserveCase={preserveCase}
                onChange={(value) => store.update({ replacement: value })}
                onTogglePreserveCase={() => store.update({ preserveCase: !preserveCase })}
                onKeyDown={onReplaceKey}
              />
              <button
                type="button"
                className="btn find-action"
                data-testid="search-replace-all"
                title="Replace All… (Enter): pick the matches, then confirm"
                disabled={!results || results.total === 0 || invalid || preview !== null}
                onMouseDown={(e) => e.preventDefault()}
                onClick={startPreview}
              >
                Replace All…
              </button>
            </div>
          )}
        </div>
      </div>
      <label className="search-scope">
        <span>Search in</span>
        <select data-testid="search-scope" value={scopeValue} onChange={(e) => setScope(e.target.value)}>
          <option value="all">All notebooks</option>
          <option value="notebook">This notebook</option>
          {sections.length > 0 && (
            <optgroup label="Section">
              {sections.map((s) => (
                <option key={s.id} value={`section:${s.id}`}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {results && !invalid && (
        <div className="search-summary" data-testid="search-summary">
          {summaryText(results)}
        </div>
      )}
      {request && (
        <div className="search-replace-bar">
          <button type="button" className="btn primary find-action" data-testid="search-replace-confirm" disabled={request.pages.length === 0 || replacing} onClick={confirm}>
            {confirmText(request)}
          </button>
          <button type="button" className="btn find-action" data-testid="search-replace-cancel" disabled={replacing} onClick={() => store.update({ preview: null })}>
            Cancel
          </button>
        </div>
      )}
      <div className="search-results" data-testid="search-results" ref={treeRef} role="tree" aria-label="Search results" tabIndex={rows.length > 0 ? 0 : -1} onKeyDown={onTreeKey}>
        {rows.map((row, i) =>
          row.kind === 'page' ? (
            <div
              key={row.page.pageId}
              className="search-group"
              data-testid="search-group"
              role="treeitem"
              aria-expanded={!collapsed.has(row.page.pageId)}
              aria-selected={i === activeRow}
              onClick={() => {
                setActive(i)
                toggleGroup(row.page.pageId)
              }}
            >
              <span className="search-chevron" aria-hidden="true">
                {collapsed.has(row.page.pageId) ? '›' : '⌄'}
              </span>
              {preview && (
                <TickBox
                  label={`Replace in ${row.page.pageTitle || 'Untitled page'}`}
                  ticked={row.page.matches.map((_, m) => !preview.unticked.has(tickKey(row.page.pageId, m)))}
                  onChange={(on) => setTicks(row.page.matches.map((_, m) => tickKey(row.page.pageId, m)), on)}
                />
              )}
              {/* The inner spans keep an ellipsised name's text inside its own box (UI audit: overlap). */}
              <span className="search-page-title" title={row.page.pageTitle || 'Untitled page'}>
                <span>{row.page.pageTitle || 'Untitled page'}</span>
              </span>
              <span className="search-section" title={row.page.sectionName}>
                <span>{row.page.sectionName}</span>
              </span>
              <span className="search-count" data-testid="search-count">
                {row.page.matches.length}
              </span>
            </div>
          ) : (
            <div
              key={`${row.page.pageId}:${row.index}`}
              className="search-match"
              data-testid="search-match"
              role="treeitem"
              aria-selected={i === activeRow}
              onClick={() => {
                setActive(i)
                open(row)
              }}
            >
              {preview && <TickBox label="Replace this match" ticked={[!preview.unticked.has(tickKey(row.page.pageId, row.index))]} onChange={(on) => setTicks([tickKey(row.page.pageId, row.index)], on)} />}
              <Snippet match={row.match} {...(replaceWith ? { replaceWith } : {})} />
            </div>
          ),
        )}
      </div>
    </aside>
  )
}

/** A preview's tick box: ticked when all of `ticked` are, mixed when some are. Clicking it never opens the row. */
function TickBox({ label, ticked, onChange }: { label: string; ticked: boolean[]; onChange: (on: boolean) => void }) {
  const all = ticked.every(Boolean)
  const some = !all && ticked.some(Boolean)
  return (
    <input
      type="checkbox"
      className="search-tick"
      aria-label={label}
      checked={all}
      ref={(el) => {
        if (el) el.indeterminate = some
      }}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}
