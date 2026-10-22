import type { Editor } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'

export type LinkInput = { href: string } | { error: string }

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])
// "example.com:8080/x" is a host and port, not a scheme.
const HOST_PORT = /^[^/?#:]+:\d+(?:[/?#]|$)/
const DOMAIN_OR_PATH = /^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]\S*)?$/i

/**
 * Turns what the user typed into a link target. Browsers ignore tabs and newlines inside a
 * scheme, so `java\tscript:` is checked as `javascript:`.
 */
export function normalizeLinkInput(raw: string): LinkInput {
  const text = raw.trim()
  if (!text) return { error: 'Enter a web address' }
  const squashed = text.replace(/[\s\u0000-\u001f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(squashed)
  if (scheme && !HOST_PORT.test(squashed)) {
    if (!SAFE_SCHEMES.has(scheme[1].toLowerCase())) return { error: `Links can't use ${scheme[1].toLowerCase()}:` }
    return { href: text }
  }
  if (!DOMAIN_OR_PATH.test(text)) return { error: 'Enter a web address' }
  return { href: `https://${text}` }
}

/** Whether pasted text is exactly one http(s) or mailto URL, the case that links a selection. */
export function isSingleUrl(text: string): boolean {
  return /^(?:https?:\/\/|mailto:)\S+$/i.test(text.trim())
}

/** What the open link popover is editing. One at a time: only the focused box has one. */
export interface LinkPopoverState {
  editor: Editor
  /** Collapsed selection outside a link: the popover also asks for the text to insert. */
  askText: boolean
  href: string
  /** The range to link, or where the new text goes. */
  from: number
  to: number
  /** Whether a link is being edited, so Remove link shows. */
  existing: boolean
}

let popover: LinkPopoverState | null = null
const listeners = new Set<() => void>()

export const linkPopover = {
  get: (): LinkPopoverState | null => popover,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  close(): void {
    if (!popover) return
    popover = null
    listeners.forEach((l) => l())
  },
}

/** Mod+K: edit the link under the selection, link the selected text, or insert linked text. */
export function openLinkPopover(editor: Editor | null): boolean {
  if (!editor || editor.isDestroyed) return false
  // ProseMirror reads a DOM selection change a moment later (selectionchange); a quick
  // select-then-Mod+K would otherwise see the old, empty selection and insert the URL as new text.
  ;(editor.view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush()
  if (editor.state.selection.empty && editor.isActive('link')) editor.chain().extendMarkRange('link').run()
  const { from, to, empty } = editor.state.selection
  const existing = editor.isActive('link')
  popover = {
    editor,
    askText: empty,
    href: existing ? ((editor.getAttributes('link').href as string | undefined) ?? '') : '',
    from,
    to,
    existing,
  }
  listeners.forEach((l) => l())
  return true
}

/** Links the selection when the text is one URL; otherwise pastes it as plain text. */
export function pastePlainOrLink(view: EditorView, text: string): void {
  const { from, to, empty } = view.state.selection
  if (empty || !isSingleUrl(text)) {
    view.pasteText(text)
    return
  }
  view.dispatch(view.state.tr.addMark(from, to, view.state.schema.marks.link.create({ href: text.trim() })))
}
