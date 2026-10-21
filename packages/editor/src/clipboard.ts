import { DOMSerializer, type Fragment, type Schema, type Slice } from '@tiptap/pm/model'
import { toPlainText, type PMJSON } from '@slate/core'

const KEEP_PASTE_ATTRS = new Set(['href', 'src', 'alt', 'start', 'colspan', 'rowspan'])

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes))
}

function wrapContents(el: Element, tag: string): void {
  const wrapper = el.ownerDocument.createElement(tag)
  while (el.firstChild) wrapper.appendChild(el.firstChild)
  el.appendChild(wrapper)
}

/** Default paste: keep structure and bold/italic, drop the source's fonts, sizes, colours and classes. */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, script, meta, link, title').forEach((e) => e.remove())
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('*'))) {
    const weight = el.style.fontWeight
    if ((el.tagName === 'B' || el.tagName === 'STRONG') && /^(normal|[1-4]00)$/.test(weight)) {
      unwrap(el)
      continue
    }
    if (/^(bold|bolder|[6-9]00)$/.test(weight) && !/^(B|STRONG|H[1-6]|TH)$/.test(el.tagName)) wrapContents(el, 'strong')
    if (el.style.fontStyle === 'italic' && !/^(I|EM)$/.test(el.tagName)) wrapContents(el, 'em')
  }
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) if (!KEEP_PASTE_ATTRS.has(attr.name)) el.removeAttribute(attr.name)
  }
  doc.body.querySelectorAll('font, span').forEach(unwrap)
  return doc.body.innerHTML
}

/** Copied HTML keeps colour only; fonts and sizes would fight the destination app's styling. */
export function stripCopiedStyles(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const color = el.style.color
    el.removeAttribute('style')
    el.removeAttribute('class')
    for (const attr of Array.from(el.attributes)) if (attr.name.startsWith('data-')) el.removeAttribute(attr.name)
    if (color) el.style.color = color
  }
}

class CleanSerializer extends DOMSerializer {
  override serializeFragment(
    fragment: Fragment,
    options: { document?: Document } = {},
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    const out = super.serializeFragment(fragment, options, target)
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
