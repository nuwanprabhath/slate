export const COLUMN_DEFAULT = 260
export const COLUMN_MIN = 140
export const COLUMN_MAX = 480

export interface Layout {
  panelOpen: boolean
  activeTool: string
  sectionsWidth: number
  pagesWidth: number
}

const KEY = 'slate:layout'
const DEFAULTS: Layout = { panelOpen: true, activeTool: 'library', sectionsWidth: COLUMN_DEFAULT, pagesWidth: COLUMN_DEFAULT }

export function clampWidth(width: number): number {
  return Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, Math.round(width)))
}

/** Panel state and column widths — per-device conveniences, so localStorage is fine. */
export function loadLayout(): Layout {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Layout>
    return {
      panelOpen: typeof stored.panelOpen === 'boolean' ? stored.panelOpen : DEFAULTS.panelOpen,
      activeTool: typeof stored.activeTool === 'string' ? stored.activeTool : DEFAULTS.activeTool,
      sectionsWidth: typeof stored.sectionsWidth === 'number' ? clampWidth(stored.sectionsWidth) : DEFAULTS.sectionsWidth,
      pagesWidth: typeof stored.pagesWidth === 'number' ? clampWidth(stored.pagesWidth) : DEFAULTS.pagesWidth,
    }
  } catch {
    return DEFAULTS
  }
}

export function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    // Storage unavailable: the layout just won't be remembered.
  }
}
