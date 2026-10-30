import { LoroList, LoroMap, LoroText, type Delta, type Value } from 'loro-crdt'
import { compileQuery, matchAll, type FindOptions } from './find'
import type { PageDoc } from './page'

export interface ReplaceOptions {
  /** Keep the match's case pattern: ALL CAPS, Capitalised or lower. */
  preserveCase: boolean
  /** Which matches to replace, by box and the match's index within that box. All when absent. */
  only?: (boxId: string, occurrence: number) => boolean
  /**
   * Whether a node is a text block, given its type name. Lets the editor pass its schema so a block
   * holding only inline leaves counts its matches as the find bar does; without it, a block is a
   * node with text in it (the search index's rule).
   */
  isTextblock?: (nodeName: string) => boolean
}

// loro-prosemirror's layout (see content.ts).
const NODE_NAME = 'nodeName'
const CHILDREN = 'children'
/** What an inline leaf (hard break) reads as in a block's text, as in the find bar and search index. */
const LEAF = '￼'

/** The replacement in the match's case pattern (VS Code's Preserve Case). */
export function preserveCaseOf(matched: string, replacement: string): string {
  const upper = matched.toUpperCase()
  const lower = matched.toLowerCase()
  if (upper === lower || replacement === '') return replacement
  if (matched === upper) return replacement.toUpperCase()
  if (matched === lower) return replacement.toLowerCase()
  const first = String.fromCodePoint(matched.codePointAt(0)!)
  const rest = matched.slice(first.length)
  if (first === first.toUpperCase() && first !== first.toLowerCase() && rest === rest.toLowerCase()) {
    const head = String.fromCodePoint(replacement.codePointAt(0)!)
    return head.toUpperCase() + replacement.slice(head.length)
  }
  return replacement
}

/**
 * The text that replaces `text[from, to)`, a match of `re`. A regex query fills `$1`…`$9` and `$&`
 * (`$$` is a dollar; a group number past the last group stays as typed); otherwise the template is
 * literal.
 */
export function expandReplacement(text: string, from: number, to: number, re: RegExp, template: string, opts: FindOptions, preserveCase: boolean): string {
  let out = template
  if (opts.regex) {
    re.lastIndex = from
    const m = re.exec(text)
    const groups: Array<string | undefined> = m && m.index === from && m[0].length === to - from ? [...m] : [text.slice(from, to)]
    out = template.replace(/\$(\$|&|[1-9])/g, (all, g: string) => {
      if (g === '$') return '$'
      if (g === '&') return groups[0] ?? ''
      const n = Number(g)
      return n < groups.length ? (groups[n] ?? '') : all
    })
  }
  return preserveCase ? preserveCaseOf(text.slice(from, to), out) : out
}

interface Segment {
  start: number
  text: LoroText
}

/** A text block's text as the find bar reads it, and where each LoroText sits in it. */
function blockText(children: LoroList): { value: string; segments: Segment[] } {
  let value = ''
  const segments: Segment[] = []
  for (const child of children.toArray()) {
    if (child instanceof LoroText) {
      segments.push({ start: value.length, text: child })
      value += child.toString()
    } else value += LEAF
  }
  return { value, segments }
}

/** The marks on the character at `at`, as the delta's attributes. */
function attributesAt(text: LoroText, at: number): Record<string, Value> | undefined {
  return text.sliceDelta(at, at + 1)[0]?.attributes as Record<string, Value> | undefined
}

/**
 * Replaces the query's matches in every box of the page, in reading order. A match never crosses a
 * text block; one that spans an inline leaf counts as an occurrence but is left alone. The
 * replacement carries exactly the marks of the match's first character. Returns how many were
 * replaced. Does not commit: the caller commits once, with its origin, so the whole change is one
 * undo step.
 */
export function replaceInPage(page: PageDoc, query: string, opts: FindOptions, replacement: string, options: ReplaceOptions): number {
  const re = compileQuery(query, opts)
  if (!re) return 0
  const boxes = page.listBoxes().sort((a, b) => a.y - b.y || a.x - b.x)
  let replaced = 0
  for (const box of boxes) {
    const root = page.contentMap(box.id)
    if (!root || root.size === 0) continue
    let occurrence = 0
    const isTextblock = options.isTextblock
    const visit = (node: LoroMap): void => {
      const children = node.get(CHILDREN)
      if (!(children instanceof LoroList)) return
      const items = children.toArray()
      const textblock = isTextblock ? isTextblock(String(node.get(NODE_NAME))) : items.some((c) => c instanceof LoroText)
      if (!textblock) {
        for (const c of items) if (c instanceof LoroMap) visit(c)
        return
      }
      const { value, segments } = blockText(children)
      const edits: Array<{ seg: Segment; from: number; to: number; with: string }> = []
      for (const [from, to] of matchAll(value, re, opts.wholeWord)) {
        const index = occurrence++
        if (options.only && !options.only(box.id, index)) continue
        const seg = segments.find((s) => from >= s.start && to <= s.start + s.text.length)
        if (!seg) continue
        edits.push({ seg, from, to, with: expandReplacement(value, from, to, re, replacement, opts, options.preserveCase) })
      }
      // Back to front, so earlier offsets still hold.
      for (const e of edits.reverse()) {
        const at = e.from - e.seg.start
        const attributes = attributesAt(e.seg.text, at)
        const delta: Delta<string>[] = [{ retain: at }, { delete: e.to - e.from }]
        // applyDelta drops marks the insert would inherit from a neighbour but does not name.
        if (e.with !== '') delta.push(attributes ? { insert: e.with, attributes } : { insert: e.with })
        if (at === 0) delta.shift()
        e.seg.text.applyDelta(delta)
        replaced++
      }
    }
    visit(root)
  }
  return replaced
}

