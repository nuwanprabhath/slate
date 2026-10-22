export const COLUMN_MIN = 100
export const COLUMN_MAX = 480

export interface Layout {
  panelOpen: boolean
  activeTool: string
  /** `null` means the column fits its longest name. */
  sectionsWidth: number | null
  pagesWidth: number | null
  /** Manual width of the whole side pane in the Search view; `null` matches the Library's total. */
  searchWidth: number | null
}

/** Bumped when stored widths change meaning; layouts older than v2 reset their widths to auto. */
const VERSION = 3
const KEY = 'slate:layout'
const DEFAULTS: Layout = { panelOpen: true, activeTool: 'library', sectionsWidth: null, pagesWidth: null, searchWidth: null }

export const PANE_MIN = 200

/** The side pane is at most half the window; the minimum wins in a very narrow window. */
export function clampPane(width: number, windowWidth: number): number {
  return Math.max(PANE_MIN, Math.min(Math.floor(windowWidth / 2), Math.round(width)))
}

/** One width for the whole side pane, whichever view is shown: the manual Search width, else the Library's total. */
export function paneWidth(manual: number | null, libraryTotal: number, windowWidth: number): number {
  return clampPane(manual ?? libraryTotal, windowWidth)
}

/**
 * A manual Search width becomes the Library's total too, so switching views never moves the page
 * area: the two Library columns are scaled proportionally to fill it. The first column gets the
 * rounded share and the second the remainder, so they always add up to `total`.
 */
export function scaleColumns(sections: number, pages: number, total: number): [number, number] {
  const sum = sections + pages
  const first = sum > 0 ? Math.round((total * sections) / sum) : Math.round(total / 2)
  return [first, total - first]
}

export function clampWidth(width: number): number {
  return Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, Math.round(width)))
}

export interface MeasuredRow {
  /** Rendered width of the name, unclipped. */
  text: number
  /** Everything else in the row: padding, colour tab or chevron, gaps, badges. */
  chrome: number
}

/** Width a column needs for its widest row and its footer, clamped. */
export function fitWidth(rows: MeasuredRow[], footer = 0): number {
  const widest = rows.reduce((max, r) => Math.max(max, Math.ceil(r.text + r.chrome)), 0)
  return clampWidth(Math.max(widest, footer))
}

/** Panel state and column widths — per-device conveniences, so localStorage is fine. */
export function loadLayout(): Layout {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Layout> & { version?: number }
    // v3 only added searchWidth, so v2 column widths keep their meaning.
    const current = stored.version === VERSION || stored.version === 2
    const width = (w: unknown) => (current && typeof w === 'number' ? clampWidth(w) : null)
    return {
      panelOpen: typeof stored.panelOpen === 'boolean' ? stored.panelOpen : DEFAULTS.panelOpen,
      activeTool: typeof stored.activeTool === 'string' ? stored.activeTool : DEFAULTS.activeTool,
      sectionsWidth: width(stored.sectionsWidth),
      pagesWidth: width(stored.pagesWidth),
      searchWidth: stored.version === VERSION && typeof stored.searchWidth === 'number' ? Math.max(PANE_MIN, Math.round(stored.searchWidth)) : null,
    }
  } catch {
    return DEFAULTS
  }
}

export function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...layout, version: VERSION }))
  } catch {
    // Storage unavailable: the layout just won't be remembered.
  }
}
