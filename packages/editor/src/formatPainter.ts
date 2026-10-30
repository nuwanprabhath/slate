import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { copyFormat, type PaintedFormat } from './extensions'

interface Painter {
  format: PaintedFormat
  /** Stays on after painting (a double-click on the button) until Esc or another click on it. */
  sticky: boolean
}

let painter: Painter | null = null
const listeners = new Set<() => void>()

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') formatPainter.stop()
}

function set(next: Painter | null): void {
  painter = next
  // The brush cursor (canvas.css) follows this flag, in every box.
  if (next) document.documentElement.dataset.formatPainter = 'on'
  else delete document.documentElement.dataset.formatPainter
  document.removeEventListener('keydown', onKey, true)
  if (next) document.addEventListener('keydown', onKey, true)
  listeners.forEach((l) => l())
}

/** The format painter: one for the window, since the next selection may be in another box. */
export const formatPainter = {
  get: (): Painter | null => painter,
  start(editor: Editor, sticky: boolean): void {
    set({ format: copyFormat(editor.state), sticky })
  },
  stop(): void {
    if (painter) set(null)
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

/** Paints a text selection the person finishes with the mouse while the painter is on. */
export const FormatPainter = Extension.create({
  name: 'formatPainter',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mouseup: () => {
              if (!painter) return false
              // ProseMirror reads the final selection from the DOM after the mouseup.
              setTimeout(() => {
                const current = painter
                if (!current || editor.isDestroyed || editor.state.selection.empty) return
                editor.commands.pasteFormat(current.format)
                if (!current.sticky) formatPainter.stop()
              }, 0)
              return false
            },
          },
        },
      }),
    ]
  },
})
