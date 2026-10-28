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
  /** Collapsed to a rail; the stored width is kept for when it expands. */
  sectionsCollapsed: boolean
  pagesCollapsed: boolean
}

/** Width of a collapsed column's rail. */
export const RAIL_WIDTH = 20

/** Bumped when stored widths change meaning; layouts older than v2 reset their widths to auto. */
const VERSION = 4
const KEY = 'slate:layout'
const DEFAULTS: Layout = { panelOpen: true, activeTool: 'library', sectionsWidth: null, pagesWidth: null, searchWidth: null, sectionsCollapsed: false, pagesCollapsed: false }

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

/**
 * Scales a manual Search width onto the expanded columns only: both expanded share it
 * proportionally, one expanded takes all but the other's rail, and a collapsed column gets `null`
 * (its stored width is left alone). `total` is the columns' space, without splitters.
 */
export function scaleExpanded(sections: number, pages: number, total: number, sectionsCollapsed: boolean, pagesCollapsed: boolean): [number | null, number | null] {
  if (sectionsCollapsed && pagesCollapsed) return [null, null]
  if (sectionsCollapsed) return [null, total - RAIL_WIDTH]
  if (pagesCollapsed) return [total - RAIL_WIDTH, null]
  return scaleColumns(sections, pages, total)
}

export function clampWidth(width: number): number {
  return Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, Math.round(width)))
}

/**
 * The widest a column grows to fit its names: a fifth of the window. Two long names once took 960 px
 * of an 800 px window and pushed the page out of it; a longer name is cut with its full text in a
 * tooltip. A width the user dragged is theirs and is not capped.
 */
export function autoFitCap(windowWidth: number): number {
  return clampWidth(Math.floor(windowWidth / 5))
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
    // v3 only added searchWidth and v4 the collapsed flags, so v2 column widths keep their meaning.
    const current = stored.version === VERSION || stored.version === 3 || stored.version === 2
    const width = (w: unknown) => (current && typeof w === 'number' ? clampWidth(w) : null)
    return {
      panelOpen: typeof stored.panelOpen === 'boolean' ? stored.panelOpen : DEFAULTS.panelOpen,
      activeTool: typeof stored.activeTool === 'string' ? stored.activeTool : DEFAULTS.activeTool,
      sectionsWidth: width(stored.sectionsWidth),
      pagesWidth: width(stored.pagesWidth),
      searchWidth: (stored.version === VERSION || stored.version === 3) && typeof stored.searchWidth === 'number' ? Math.max(PANE_MIN, Math.round(stored.searchWidth)) : null,
      sectionsCollapsed: stored.sectionsCollapsed === true,
      pagesCollapsed: stored.pagesCollapsed === true,
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

export interface LibraryBox {
  total: number
  sections: number
  pages: number
}

const BOX_KEY = 'slate:library-box'

/** The Library panel's last measured widths; 300 px total until it has been shown once. */
export function loadLibraryBox(): LibraryBox {
  try {
    const b = JSON.parse(localStorage.getItem(BOX_KEY) ?? 'null') as Partial<LibraryBox> | null
    if (b && [b.total, b.sections, b.pages].every((n) => typeof n === 'number' && Number.isFinite(n)) && b.total! > 0) {
      return { total: b.total!, sections: b.sections!, pages: b.pages! }
    }
  } catch {
    // Storage unavailable: fall back to the default below.
  }
  return { total: 300, sections: 0, pages: 0 }
}

export function saveLibraryBox(box: LibraryBox): void {
  try {
    localStorage.setItem(BOX_KEY, JSON.stringify(box))
  } catch {
    // Not remembered; the first switch after a restart may shift once.
  }
}
