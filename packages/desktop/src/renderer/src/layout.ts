export const COLUMN_MIN = 100
export const COLUMN_MAX = 480

export interface Layout {
  panelOpen: boolean
  activeTool: string
  /** `null` means the column fits its longest name. */
  sectionsWidth: number | null
  pagesWidth: number | null
}

/** Bumped when stored widths change meaning; older layouts reset their widths to auto. */
const VERSION = 2
const KEY = 'slate:layout'
const DEFAULTS: Layout = { panelOpen: true, activeTool: 'library', sectionsWidth: null, pagesWidth: null }

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
    const current = stored.version === VERSION
    const width = (w: unknown) => (current && typeof w === 'number' ? clampWidth(w) : null)
    return {
      panelOpen: typeof stored.panelOpen === 'boolean' ? stored.panelOpen : DEFAULTS.panelOpen,
      activeTool: typeof stored.activeTool === 'string' ? stored.activeTool : DEFAULTS.activeTool,
      sectionsWidth: width(stored.sectionsWidth),
      pagesWidth: width(stored.pagesWidth),
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
