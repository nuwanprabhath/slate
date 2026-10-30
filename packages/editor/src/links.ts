import { Extension, type Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { PMJSON } from '@slate/core'

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
  // eslint-disable-next-line no-control-regex -- control characters are what the pattern strips before the scheme check
  const squashed = text.replace(/[\s\u0000-\u001f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(squashed)
  if (scheme && !HOST_PORT.test(squashed)) {
    if (!SAFE_SCHEMES.has(scheme[1]!.toLowerCase())) return { error: `Links can't use ${scheme[1]!.toLowerCase()}:` }
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
    pastePlain(view, text)
    return
  }
  view.dispatch(view.state.tr.addMark(from, to, view.state.schema.marks.link!.create({ href: text.trim() })))
}

// A scheme or "www." at the start of a word, then everything up to whitespace or a character that
// cannot be in an address; what ends a sentence or wraps the address is trimmed off after.
const URL_CANDIDATE = /(?<![\w@.:/-])(?:https?:\/\/|mailto:|www\.)[^\s<>"'`]+/gi
const TRAILING = /[.,;:!?*_~]+$/

function trimAddress(raw: string): string {
  let url = raw.replace(TRAILING, '')
  // A closing bracket is the address's own only when it closes one inside it: wiki/Slate_(rock).
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1).replace(TRAILING, '')
  }
  return url
}

/** The web and mail addresses in `text`, each with the href a link to it gets. */
export function findUrls(text: string): Array<{ from: number; to: number; href: string }> {
  const found: Array<{ from: number; to: number; href: string }> = []
  for (const m of text.matchAll(URL_CANDIDATE)) {
    const url = trimAddress(m[0])
    const rest = url.replace(/^(?:https?:\/\/|mailto:|www\.)/i, '')
    if (!/[\w]/.test(rest) || (/^mailto:/i.test(url) && !rest.includes('@'))) continue
    const input = normalizeLinkInput(url)
    if ('error' in input) continue
    found.push({ from: m.index, to: m.index + url.length, href: input.href })
  }
  return found
}

/** Pasted text as paragraphs, one per line, with its addresses linked when `link` is on (a paste onto the bare canvas). */
export function linkedTextBlocks(text: string, link: boolean): PMJSON[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const content: PMJSON[] = []
      let at = 0
      for (const u of link ? findUrls(line) : []) {
        if (u.from > at) content.push({ type: 'text', text: line.slice(at, u.from) })
        content.push({ type: 'text', text: line.slice(u.from, u.to), marks: [{ type: 'link', attrs: { href: u.href } }] })
        at = u.to
      }
      if (at < line.length) content.push({ type: 'text', text: line.slice(at) })
      return { type: 'paragraph', content }
    })
}

function linkText(node: PMNode, schema: Schema): PMNode[] | null {
  const link = schema.marks.link!
  if (node.marks.some((m) => m.type === link || m.type.spec.code)) return null
  const text = node.text ?? ''
  const urls = findUrls(text)
  if (urls.length === 0) return null
  const out: PMNode[] = []
  let at = 0
  for (const u of urls) {
    if (u.from > at) out.push(node.cut(at, u.from))
    out.push(node.cut(u.from, u.to).mark(link.create({ href: u.href }).addToSet(node.marks)))
    at = u.to
  }
  if (at < text.length) out.push(node.cut(at))
  return out
}

function linkFragment(fragment: Fragment, schema: Schema): Fragment | null {
  let changed = false
  const out: PMNode[] = []
  fragment.forEach((node) => {
    const linked = node.isText ? linkText(node, schema) : null
    const inner = !node.isText && !node.isLeaf && !node.type.spec.code ? linkFragment(node.content, schema) : null
    if (linked) out.push(...linked)
    else if (inner) out.push(node.copy(inner))
    else out.push(node)
    changed ||= linked !== null || inner !== null
  })
  return changed ? Fragment.from(out) : null
}

let plainPastes = 0

/** Mod+Shift+V: pastes `text` with nothing added, not even links. */
export function pastePlain(view: EditorView, text: string): void {
  plainPastes++
  try {
    view.pasteText(text)
  } finally {
    plainPastes--
  }
}

/**
 * Pasted web and mail addresses become links (the "Make pasted addresses links" setting), whether
 * they came as text or inside HTML. Existing links and code are left alone, and paste as plain text
 * adds nothing.
 */
export const PastedLinks = Extension.create<{ enabled: boolean }>({
  name: 'pastedLinks',
  addOptions() {
    return { enabled: true }
  },
  addProseMirrorPlugins() {
    const { enabled } = this.options
    return [
      new Plugin({
        props: {
          transformPasted: (slice, view) => {
            if (!enabled || plainPastes > 0) return slice
            const content = linkFragment(slice.content, view.state.schema)
            return content ? new Slice(content, slice.openStart, slice.openEnd) : slice
          },
        },
      }),
    ]
  },
})
