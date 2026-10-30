import { toMarkdown, type PMJSON } from '@slate/core'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { pastePlainOrLink } from './links'
import type { EditorServices } from './services'

/** The selection as Markdown (`toMarkdown`, the one serializer). */
export function selectionMarkdown(state: EditorState): string {
  return toMarkdown((state.selection.content().content.toJSON() as PMJSON[] | null) ?? [])
}

// Set only while copyAsMarkdown's own copy event runs, which execCommand dispatches synchronously.
let markdownCopy = false

/**
 * Copy as Markdown is a copy whose text/plain is Markdown. It runs as a real copy event, so it lands
 * on the clipboard the way Mod+C does and the lock still knows to clear it (lock/relay.ts).
 */
export function copyAsMarkdown(view: EditorView): boolean {
  if (view.state.selection.empty) return false
  view.focus()
  markdownCopy = true
  try {
    return document.execCommand('copy')
  } finally {
    markdownCopy = false
  }
}

/** The box editor's copy handler for Copy as Markdown; any other copy is left to the next handler. */
export function copyMarkdownInto(view: EditorView, event: ClipboardEvent): boolean {
  if (!markdownCopy || !event.clipboardData) return false
  event.preventDefault()
  event.clipboardData.clearData()
  event.clipboardData.setData('text/plain', selectionMarkdown(view.state))
  return true
}

/** Paste as Plain Text, from Mod+Shift+V or the text menu. */
export function pastePlainText(view: EditorView, services: Pick<EditorServices, 'readClipboardText'>): void {
  void services.readClipboardText().then((text) => {
    if (!view.isDestroyed) pastePlainOrLink(view, text)
  })
}
