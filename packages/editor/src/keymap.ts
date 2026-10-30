import { Extension } from '@tiptap/core'
import { openLinkPopover } from './links'
import type { PageSession } from './PageSession'
import type { EditorServices } from './services'
import { copyAsMarkdown, pastePlainText } from './textCommands'

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
        if (this.options.services) pastePlainText(this.editor.view, this.options.services)
        return true
      },
      'Mod-k': () => openLinkPopover(this.editor),
      'Mod-Alt-Shift-c': () => copyAsMarkdown(this.editor.view),
    }
  },
})
