import type { Editor } from '@tiptap/core'

let active: Editor | null = null
const listeners = new Set<() => void>()

/** The most recently focused box editor. Kept after blur so toolbar controls can act on it. */
export const activeEditor = {
  get: (): Editor | null => active,
  set(editor: Editor | null): void {
    if (active === editor) return
    active = editor
    listeners.forEach((l) => l())
  },
  clear(editor: Editor): void {
    if (active === editor) activeEditor.set(null)
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
