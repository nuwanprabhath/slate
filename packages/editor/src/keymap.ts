import { Extension } from '@tiptap/core'
import type { PageSession } from './PageSession'
import type { EditorServices } from './services'

/** Page-wide undo/redo (Loro) and plain-text paste. */
export const SlateKeymap = Extension.create<{ session: PageSession | null; services: EditorServices | null }>({
  name: 'slateKeymap',
  addOptions() {
    return { session: null, services: null }
  },
  addKeyboardShortcuts() {
    const undo = () => {
      this.options.session?.undo()
      return true
    }
    const redo = () => {
      this.options.session?.redo()
      return true
    }
    return {
      'Mod-z': undo,
      'Mod-Shift-z': redo,
      'Mod-y': redo,
      'Mod-Shift-v': () => {
        const view = this.editor.view
        void this.options.services?.readClipboardText().then((text) => {
          if (!view.isDestroyed) view.pasteText(text)
        })
        return true
      },
    }
  },
})
