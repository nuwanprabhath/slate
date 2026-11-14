import { DOMSerializer, type Fragment, type Schema, type Slice } from '@tiptap/pm/model'
import { toPlainText, type PMJSON } from '@slate/core'
import { urlScheme } from './links'

// data: is stored by storeDataImages and comes back as slate-blob; a src with no scheme or any other is refused.
const IMAGE_SCHEMES = new Set(['http', 'https', 'data', 'slate-blob'])

/** Whether a picture may load from `src`. Applied on paste and by the Image node, so neither layer trusts the other. */
export function isSafeImageSrc(src: string): boolean {
  const scheme = urlScheme(src)
  return scheme !== null && IMAGE_SCHEMES.has(scheme)
}

// The deepest element a paste keeps. The schema's deepest real structure is a few levels (a table cell in a
// list item in a nested list in a blockquote, about a dozen elements with marks); 32 leaves room for real
// documents' wrapper divs and keeps ProseMirror's recursive DOM parser far from the stack's end.
export const MAX_PASTE_DEPTH = 32

// Where a table's parts may stand; anything else a re-parse would move out (foster parenting) or drop.
const TABLE_CHILDREN: Record<string, Set<string>> = {
  TABLE: new Set(['CAPTION', 'COLGROUP', 'THEAD', 'TBODY', 'TFOOT', 'TR']),
  THEAD: new Set(['TR']),
  TBODY: new Set(['TR']),
  TFOOT: new Set(['TR']),
  TR: new Set(['TD', 'TH']),
  COLGROUP: new Set(['COL']),
}
const TABLE_PARTS = /^(CAPTION|COLGROUP|COL|THEAD|TBODY|TFOOT|TR|TD|TH)$/
const TABLE_PARENTS: Record<string, RegExp> = {
  CAPTION: /^TABLE$/,
  COLGROUP: /^TABLE$/,
  THEAD: /^TABLE$/,
  TBODY: /^TABLE$/,
  TFOOT: /^TABLE$/,
  TR: /^(TABLE|THEAD|TBODY|TFOOT)$/,
  TD: /^TR$/,
  TH: /^TR$/,
  COL: /^COLGROUP$/,
}

/**
 * Makes table markup what a parser would read back unchanged: a cell, row or section outside its
 * parent is unwrapped to its contents, and content standing directly in a table's structure moves
 * out in front of the table. Without this a second parse restructures it and can lose a cell.
 */
function settleTables(body: HTMLElement): void {
  for (const el of Array.from(body.querySelectorAll('*')).reverse()) {
    if (TABLE_PARTS.test(el.tagName) && !TABLE_PARENTS[el.tagName]!.test(el.parentElement?.tagName ?? '')) unwrap(el)
  }
  for (const el of Array.from(body.querySelectorAll('table, thead, tbody, tfoot, tr, colgroup'))) {
    const allowed = TABLE_CHILDREN[el.tagName]!
    const table = el.closest('table')!
    for (const child of Array.from(el.childNodes)) {
      const misplaced = child.nodeType === 1 ? !allowed.has((child as Element).tagName) : child.nodeType === 3 && /\S/.test(child.textContent ?? '')
      if (misplaced) table.before(child)
    }
  }
}

/** Unwraps elements deeper than MAX_PASTE_DEPTH, deepest first, so their text stays and the nesting does not. */
function capDepth(body: HTMLElement): void {
  const depth = new Map<Element, number>([[body, 0]])
  const tooDeep: Element[] = []
  for (const el of Array.from(body.querySelectorAll('*'))) {
    const d = (depth.get(el.parentElement!) ?? 0) + 1
    depth.set(el, d)
    if (d > MAX_PASTE_DEPTH) tooDeep.push(el)
  }
  for (const el of tooDeep.reverse()) unwrap(el)
}

const KEEP_PASTE_ATTRS = new Set(['href', 'src', 'alt', 'start', 'colspan', 'rowspan'])

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes))
}

function wrapContents(el: Element, tag: string): void {
  const wrapper = el.ownerDocument.createElement(tag)
  while (el.firstChild) wrapper.appendChild(el.firstChild)
  el.appendChild(wrapper)
}

// Alignment is structure, not styling: paste and copy keep it (the one inline style besides colour).
const ALIGNMENTS = new Set(['center', 'right'])
const ALIGNABLE = /^(P|H[1-6])$/
// So is a paragraph's indent (WP-C2), kept as a pixel left margin.
const indentMargin = (el: HTMLElement): string => (ALIGNABLE.test(el.tagName) && /^\d+(\.\d+)?px$/.test(el.style.marginLeft) ? el.style.marginLeft : '')

/** Default paste: keep structure and bold/italic, drop the source's fonts, sizes, colours and classes. */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, script, meta, link, title').forEach((e) => e.remove())
  // Comments carry nothing a page keeps (Word's conditional blocks) and a CDATA-turned-comment re-parses differently.
  const comments = doc.createTreeWalker(doc.body, 128 /* NodeFilter.SHOW_COMMENT */)
  const dropped: Node[] = []
  while (comments.nextNode()) dropped.push(comments.currentNode)
  dropped.forEach((c) => c.parentNode?.removeChild(c))
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('*'))) {
    const weight = el.style.fontWeight
    if ((el.tagName === 'B' || el.tagName === 'STRONG') && /^(normal|[1-4]00)$/.test(weight)) {
      unwrap(el)
      continue
    }
    if (/^(bold|bolder|[6-9]00)$/.test(weight) && !/^(B|STRONG|H[1-6]|TH)$/.test(el.tagName)) wrapContents(el, 'strong')
    if (el.style.fontStyle === 'italic' && !/^(I|EM)$/.test(el.tagName)) wrapContents(el, 'em')
  }
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('*'))) {
    const align = ALIGNABLE.test(el.tagName) && ALIGNMENTS.has(el.style.textAlign) ? el.style.textAlign : ''
    const margin = indentMargin(el)
    // A to-do item's box (Slate's own copy, GitHub task lists) keeps its type and tick.
    // An image's width is its size on the page (imageResize.ts), not the source's styling.
    const keep = (name: string) =>
      KEEP_PASTE_ATTRS.has(name) || (el.tagName === 'INPUT' && (name === 'type' || name === 'checked')) || (el.tagName === 'IMG' && name === 'width')
    for (const attr of Array.from(el.attributes)) if (!keep(attr.name)) el.removeAttribute(attr.name)
    if (align) el.style.textAlign = align
    if (margin) el.style.marginLeft = margin
  }
  doc.body.querySelectorAll('font, span').forEach(unwrap)
  doc.body.querySelectorAll('img').forEach((img) => {
    if (!isSafeImageSrc(img.getAttribute('src') ?? '')) img.remove()
  })
  settleTables(doc.body)
  capDepth(doc.body)
  // A parser drops whitespace before the body's first content, so the output starts without it.
  const first = doc.body.firstChild
  if (first?.nodeType === 3) first.textContent = (first.textContent ?? '').replace(/^[\t\n\f\r ]+/, '')
  return doc.body.innerHTML
}

// The formats the blob store keeps; an embedded SVG or anything else is not stored.
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'])
const BASE64_PICTURE = /^data:(image\/[a-z]+);base64,([a-z0-9+/=\s]*)$/i

/**
 * Whether pasted HTML has any picture, which then goes through `storeDataImages`. A cheap test on
 * the text: whether a src holds a data URL is decided from the parsed attribute, since entities
 * (`&#100;ata:`) and `<img/src=…>` hide it from any pattern.
 */
export function mayHoldImages(html: string): boolean {
  return /<img/i.test(html)
}

/** A src as the URL parser reads it: tabs and newlines removed, surrounding spaces and controls trimmed. */
function urlOf(src: string): string {
  // eslint-disable-next-line no-control-regex -- the URL standard strips exactly these
  return src.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
}

/**
 * Stores each embedded picture through `put` and points the HTML at the stored copy, so a page
 * holds an address and never the bytes (they would stay in its history and every sync for good).
 * A picture that cannot be stored is left out.
 */
export async function storeDataImages(html: string, put: (bytes: Uint8Array, mime: string) => Promise<string>): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = urlOf(img.getAttribute('src') ?? '')
    if (!/^data:/i.test(src)) continue
    const match = BASE64_PICTURE.exec(src)
    const mime = match?.[1]?.toLowerCase() ?? ''
    try {
      if (!match || !PICTURE_TYPES.has(mime)) throw new Error('not a stored picture format')
      img.setAttribute('src', await put(Uint8Array.from(atob(match[2]!.replace(/\s/g, '')), (c) => c.charCodeAt(0)), mime))
    } catch {
      img.remove()
    }
  }
  return doc.body.innerHTML
}

/**
 * Copied HTML keeps colour only; fonts and sizes would fight the destination app's styling. The
 * colour is the stored one (data-color), not the one adapted for Slate's dark theme: the
 * destination draws on its own background.
 */
export function stripCopiedStyles(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const stored = el.getAttribute('data-color')
    const color = stored && el.style.color && el.style.color !== 'inherit' ? stored : el.style.color
    const align = ALIGNMENTS.has(el.style.textAlign) ? el.style.textAlign : ''
    const taskList = el.getAttribute('data-type') === 'taskList'
    const margin = indentMargin(el)
    el.removeAttribute('style')
    el.removeAttribute('class')
    for (const attr of Array.from(el.attributes)) if (attr.name.startsWith('data-')) el.removeAttribute(attr.name)
    if (align) el.style.textAlign = align
    if (color) el.style.color = color
    if (margin) el.style.marginLeft = margin
    if (taskList) el.setAttribute('data-type', 'taskList')
  }
}

/** To-do items copy as other apps' task lists: `<ul data-type="taskList"><li><input type="checkbox" checked disabled>…`. */
function copyTodoBoxes(root: ParentNode): void {
  for (const li of Array.from(root.querySelectorAll('li[data-checked]'))) {
    const box = li.ownerDocument.createElement('input')
    box.setAttribute('type', 'checkbox')
    if (li.getAttribute('data-checked') === 'true') box.setAttribute('checked', '')
    box.setAttribute('disabled', '')
    li.prepend(box)
    li.removeAttribute('data-checked')
    li.parentElement?.setAttribute('data-type', 'taskList')
  }
}

class CleanSerializer extends DOMSerializer {
  override serializeFragment(
    fragment: Fragment,
    options: { document?: Document } = {},
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    const out = super.serializeFragment(fragment, options, target)
    copyTodoBoxes(out)
    stripCopiedStyles(out)
    return out
  }
}

export function makeClipboardSerializer(schema: Schema): DOMSerializer {
  return new CleanSerializer(DOMSerializer.nodesFromSchema(schema), DOMSerializer.marksFromSchema(schema))
}

export function serializeSliceAsText(slice: Slice): string {
  return toPlainText((slice.content.toJSON() as PMJSON[] | null) ?? [])
}
