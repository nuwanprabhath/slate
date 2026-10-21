export interface Selection {
  notebookId: string | null
  sectionId: string | null
  pageId: string | null
}

const KEY = 'slate:selection'
const EMPTY: Selection = { notebookId: null, sectionId: null, pageId: null }

/** Last opened notebook/section/page — a per-device convenience, so localStorage is fine. */
export function loadSelection(): Selection {
  try {
    return { ...EMPTY, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Selection>) }
  } catch {
    return EMPTY
  }
}

export function saveSelection(selection: Selection): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(selection))
  } catch {
    // Storage unavailable: selection just won't be remembered.
  }
}
