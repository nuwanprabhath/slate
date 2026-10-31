import { Extension, getSchema, InputRule, mergeAttributes, type ChainedCommands, type Editor, type Extensions } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { Color, FontFamily, FontSize, TextStyle as BaseTextStyle } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { currentTheme, readableColor, readableHighlight } from './colorContrast'
import { MoveBlocks } from './moveBlocks'

const lowlight = createLowlight(common)

/**
 * Imported runs carry literal colours (mostly black) that OneNote draws adaptively. The mark
 * attribute keeps the original (Loro, MCP, export); only the DOM gets a colour readable on the
 * current theme. data-color holds the original and wins when parsing, so copy/paste inside
 * Slate round-trips it.
 */
const AdaptiveColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-color') ?? (el.style.color.replace(/['"]+/g, '') || null),
            renderHTML: (attrs) => {
              const color = attrs.color as string | null
              if (!color) return {}
              return { 'data-color': color, style: `color: ${readableColor(color, currentTheme().background)}` }
            },
          },
        },
      },
    ]
  },
})

const AdaptiveHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-color') || el.style.backgroundColor || null,
        renderHTML: (attrs) => {
          const color = attrs.color as string | null
          if (!color) return {}
          const bg = readableHighlight(color, currentTheme().text)
          return {
            'data-color': color,
            style: bg ? `background-color: ${bg}; color: inherit` : 'background-color: transparent; color: inherit',
          }
        },
      },
    }
  },
})

/** A list's marker style (disc, lower-alpha, upper-roman…), set from the toolbar's list menus. */
const ListStyle = Extension.create({
  name: 'listStyle',
  addGlobalAttributes() {
    return [
      {
        types: ['bulletList', 'orderedList'],
        attributes: {
          listStyle: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-list-style') || null,
            renderHTML: (attrs) => {
              const style = attrs.listStyle as string | null
              return style ? { 'data-list-style': style, style: `list-style-type: ${style}` } : {}
            },
          },
        },
      },
    ]
  },
})

/**
 * An empty line has no text to size its line box, so the caret there is drawn at the box's default
 * size even when what will be typed is 32px. The line takes the pending marks' size and font in the
 * view only; the document keeps a bare paragraph.
 */
const EmptyLineStyle = Extension.create({
  name: 'emptyLineStyle',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const { selection } = state
            const parent = selection.$from.parent
            if (!selection.empty || !parent.isTextblock || parent.content.size > 0) return null
            const style = (state.storedMarks ?? selection.$from.marks()).find((m) => m.type.name === 'textStyle')?.attrs
            const css = [style?.fontSize && `font-size: ${style.fontSize}`, style?.fontFamily && `font-family: ${style.fontFamily}`].filter(Boolean).join('; ')
            if (!css) return null
            const pos = selection.$from.before()
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + parent.nodeSize, { style: css })])
          },
        },
      }),
    ]
  },
})

// --- autoBullets (WP-H) ---
/**
 * The one auto-format Slate applies by default: "* " at the start of a plain paragraph starts a
 * bullet list. Kept apart from StarterKit's markdown rules so it works with Markdown Shortcuts off
 * (the editor enables input rules for this extension by name). Backspace right after undoes it.
 */
export const AutoBullets = Extension.create({
  name: 'autoBullets',
  addInputRules() {
    return [
      new InputRule({
        find: /^\*\s$/,
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.parent.type.name !== 'paragraph' || $from.depth !== 1) return null
          chain().deleteRange(range).toggleBulletList().run()
          return undefined
        },
      }),
    ]
  },
})

// --- WP-C1: to-do lists, alignment, sub/superscript ---
// Each is an attribute on a node or mark 0.4.3 already has (test/olderVersions.test.ts): a device
// still on 0.4.3 shows the text and keeps the attribute unless it edits that very block, where new
// node types and marks would vanish there and be deleted from the page.

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    slateTodoList: { toggleTodoList: () => ReturnType }
    slateTextAlign: { setTextAlign: (align: TextAlign) => ReturnType }
    slateVerticalAlign: { toggleSubscript: () => ReturnType; toggleSuperscript: () => ReturnType }
  }
}

/** The innermost list item around a position, with its position. */
function listItemAround($pos: ResolvedPos): { node: PMNode; pos: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type.name === 'listItem') return { node, pos: $pos.before(d) }
  }
  return null
}

function listAround($pos: ResolvedPos): { node: PMNode; pos: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type.name === 'bulletList' || node.type.name === 'orderedList') return { node, pos: $pos.before(d) }
  }
  return null
}

/** Whether the selection is in a to-do item: one whose `checked` is true or false (null is a plain item). */
export function inTodoItem(state: EditorState): boolean {
  return (listItemAround(state.selection.$from)?.node.attrs.checked ?? null) !== null
}

function setChecked(tr: Transaction, pos: number, checked: boolean | null): void {
  const node = tr.doc.nodeAt(pos)
  if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked })
}

/**
 * A to-do item is a bulleted list item with `checked` set; the box is drawn by canvas.css and
 * ticked by a click on it. Never made from typed `[ ]`: only the toolbar and Mod+Shift+9.
 */
export const TodoList = Extension.create({
  name: 'todoList',
  priority: 110,
  addGlobalAttributes() {
    return [
      {
        types: ['listItem'],
        attributes: {
          checked: {
            default: null,
            keepOnSplit: true,
            parseHTML: (el) => {
              const data = el.getAttribute('data-checked')
              if (data === 'true' || data === 'false') return data === 'true'
              const box = Array.from(el.children).find((c) => c.tagName === 'INPUT' && c.getAttribute('type') === 'checkbox')
              return box ? box.hasAttribute('checked') : null
            },
            renderHTML: (attrs) => (attrs.checked === null || attrs.checked === undefined ? {} : { 'data-checked': String(attrs.checked) }),
          },
        },
      },
    ]
  },
  addCommands() {
    return {
      toggleTodoList:
        () =>
        ({ state, chain }) => {
          if (inTodoItem(state)) {
            return chain()
              .command(({ tr }) => {
                const { from, to } = tr.selection
                tr.doc.nodesBetween(from, to, (node, pos) => {
                  if (!node.isTextblock) return true
                  const item = listItemAround(tr.doc.resolve(pos + 1))
                  if (item && item.node.attrs.checked !== null && item.pos === pos - 1) setChecked(tr, item.pos, null)
                  return false
                })
                return true
              })
              .liftListItem('listItem')
              .run()
          }
          const list = listAround(state.selection.$from)
          const start = list?.node.type.name === 'bulletList' ? chain() : chain().toggleBulletList()
          return start
            .command(({ tr }) => {
              const around = listAround(tr.selection.$from)
              if (!around || around.node.type.name !== 'bulletList') return false
              around.node.forEach((child, offset) => {
                if (child.attrs.checked === null) setChecked(tr, around.pos + 1 + offset, false)
              })
              return true
            })
            .run()
        },
    }
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-9': () => this.editor.commands.toggleTodoList(),
      // A new item after a ticked one starts unticked.
      Enter: () => inTodoItem(this.editor.state) && this.editor.commands.splitListItem('listItem', { checked: false }),
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            // The box is the item's ::before, so a click on it lands on the <li> itself; one in the text lands on its <p>.
            mousedown: (view, event) => {
              const li = event.target
              if (event.button !== 0 || !view.editable || !(li instanceof HTMLElement) || li.tagName !== 'LI' || !li.hasAttribute('data-checked')) return false
              const pos = view.posAtDOM(li, 0) - 1
              const node = view.state.doc.nodeAt(pos)
              if (node?.type.name !== 'listItem' || node.attrs.checked === null) return false
              event.preventDefault()
              const tr = view.state.tr
              setChecked(tr, pos, !node.attrs.checked)
              view.dispatch(tr)
              return true
            },
          },
        },
      }),
    ]
  },
})

export type TextAlign = 'left' | 'center' | 'right'
const ALIGNED = new Set(['center', 'right'])

/** Paragraph and heading alignment; left is the default and stores nothing. */
export const TextAlignment = Extension.create({
  name: 'textAlign',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el) => (ALIGNED.has(el.style.textAlign) ? el.style.textAlign : null),
            renderHTML: (attrs) => (typeof attrs.textAlign === 'string' && ALIGNED.has(attrs.textAlign) ? { style: `text-align: ${attrs.textAlign}` } : {}),
          },
        },
      },
    ]
  },
  addCommands() {
    return {
      setTextAlign:
        (align) =>
        ({ commands }) => {
          const textAlign = align === 'left' ? null : align
          return ['paragraph', 'heading'].map((type) => commands.updateAttributes(type, { textAlign })).some(Boolean)
        },
    }
  },
  addKeyboardShortcuts() {
    return {
      // Mod+Shift+L is Lock Slate.
      'Mod-Alt-Shift-l': () => this.editor.commands.setTextAlign('left'),
      'Mod-Shift-e': () => this.editor.commands.setTextAlign('center'),
      'Mod-Shift-r': () => this.editor.commands.setTextAlign('right'),
    }
  },
})

type VerticalAlign = 'sub' | 'super'
const SCRIPT_TAGS: Record<VerticalAlign, string> = { sub: 'sub', super: 'sup' }

/**
 * Sub- and superscript are a `verticalAlign` attribute of the textStyle mark (so they exclude each
 * other and sit beside colour and size), drawn as <sub>/<sup>.
 */
const TextStyle = BaseTextStyle.extend({
  parseHTML() {
    return [...(this.parent?.() ?? []), { tag: 'sub' }, { tag: 'sup' }]
  },
  renderHTML({ mark, HTMLAttributes }) {
    const align = mark.attrs.verticalAlign as VerticalAlign | null
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
    return [align ? SCRIPT_TAGS[align] : 'span', attrs, 0]
  },
})

const VerticalAlignment = Extension.create({
  name: 'verticalAlign',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          verticalAlign: {
            default: null,
            parseHTML: (el) => (el.tagName === 'SUB' ? 'sub' : el.tagName === 'SUP' ? 'super' : null),
            renderHTML: () => ({}),
          },
        },
      },
    ]
  },
  addCommands() {
    const toggle =
      (align: VerticalAlign) =>
      ({ editor, chain }: { editor: Editor; chain: () => ChainedCommands }) =>
        editor.isActive('textStyle', { verticalAlign: align })
          ? chain().setMark('textStyle', { verticalAlign: null }).removeEmptyTextStyle().run()
          : chain().setMark('textStyle', { verticalAlign: align }).run()
    return { toggleSubscript: () => toggle('sub'), toggleSuperscript: () => toggle('super') }
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-,': () => this.editor.commands.toggleSubscript(),
      'Mod-Shift-.': () => this.editor.commands.toggleSuperscript(),
    }
  },
})

// --- WP-C2: indent, move blocks, format painter ---

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    slateIndent: { indent: (step: 1 | -1) => ReturnType }
  }
}

export const INDENT_STEP_PX = 24
export const MAX_INDENT = 8
const INDENTABLE = new Set(['paragraph', 'heading'])
// Inside these, Tab keeps its own meaning (nest, next cell, the code's own indentation).
const TAB_OWNERS = new Set(['listItem', 'tableCell', 'tableHeader', 'codeBlock'])

function indentFromMargin(el: HTMLElement): number | null {
  const level = Math.round(parseFloat(el.style.marginLeft.endsWith('px') ? el.style.marginLeft : '') / INDENT_STEP_PX)
  return Number.isFinite(level) && level > 0 ? Math.min(level, MAX_INDENT) : null
}

/**
 * Paragraph and heading indent, in 24px steps up to 8: an attribute on the existing nodes, so 0.4.3
 * keeps it (test/olderVersions.test.ts). Tab and Shift+Tab, only outside lists, tables and code.
 */
export const Indent = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [
      {
        types: [...INDENTABLE],
        attributes: {
          indent: {
            default: null,
            parseHTML: (el) => indentFromMargin(el),
            renderHTML: (attrs) => (typeof attrs.indent === 'number' && attrs.indent > 0 ? { style: `margin-left: ${attrs.indent * INDENT_STEP_PX}px` } : {}),
          },
        },
      },
    ]
  },
  addCommands() {
    return {
      indent:
        (step) =>
        ({ state, tr, dispatch }) => {
          const { $from, from, to } = state.selection
          for (let d = $from.depth; d > 0; d--) if (TAB_OWNERS.has($from.node(d).type.name)) return false
          if (!dispatch) return true
          tr.doc.nodesBetween(from, to, (node, pos) => {
            if (!INDENTABLE.has(node.type.name)) return !node.isTextblock && !TAB_OWNERS.has(node.type.name)
            const level = Math.max(0, Math.min(MAX_INDENT, ((node.attrs.indent as number | null) ?? 0) + step))
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: level || null })
            return false
          })
          return true
        },
    }
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.indent(1),
      'Shift-Tab': () => this.editor.commands.indent(-1),
    }
  },
})

type ListKind = 'none' | 'bullet' | 'ordered' | 'todo'

/** What the format painter carries: marks (never a link) and the block's type, alignment, indent and list. */
export interface PaintedFormat {
  marks: Array<{ type: string; attrs: Record<string, unknown> }>
  block: { type: string; level: number | null; textAlign: string | null; indent: number | null }
  list: ListKind
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    slateFormatPainter: { pasteFormat: (format: PaintedFormat) => ReturnType }
  }
}

function listKind($pos: ResolvedPos): ListKind {
  if ((listItemAround($pos)?.node.attrs.checked ?? null) !== null) return 'todo'
  const list = listAround($pos)?.node.type.name
  return list === 'bulletList' ? 'bullet' : list === 'orderedList' ? 'ordered' : 'none'
}

/** The format at the start of the selection (or the caret's pending marks). */
export function copyFormat(state: EditorState): PaintedFormat {
  const { $from, from, empty } = state.selection
  const first = empty ? null : state.doc.nodeAt(from)
  const marks = first?.isText ? first.marks : (state.storedMarks ?? $from.marks())
  const block = $from.parent
  return {
    marks: marks.filter((m) => m.type.name !== 'link').map((m) => ({ type: m.type.name, attrs: { ...m.attrs } })),
    block: {
      type: block.type.name,
      level: typeof block.attrs.level === 'number' ? block.attrs.level : null,
      textAlign: (block.attrs.textAlign as string | null | undefined) ?? null,
      indent: (block.attrs.indent as number | null | undefined) ?? null,
    },
    list: listKind($from),
  }
}

/** Clears `checked` on the selected items: to-do items become bulleted ones. */
const clearTodo = ({ tr }: { tr: Transaction }) => {
  tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
    if (node.type.name === 'listItem' && node.attrs.checked !== null) setChecked(tr, pos, null)
  })
  return true
}

function toList(c: ChainedCommands, from: ListKind, to: ListKind): ChainedCommands {
  if (from === to) return c
  switch (to) {
    case 'none':
      return from === 'todo' ? c.toggleTodoList() : from === 'bullet' ? c.toggleBulletList() : c.toggleOrderedList()
    case 'bullet':
      return from === 'todo' ? c.command(clearTodo) : c.toggleBulletList()
    case 'ordered':
      return (from === 'todo' ? c.command(clearTodo) : c).toggleOrderedList()
    case 'todo':
      return c.toggleTodoList()
  }
}

/**
 * The format painter's paste: an explicit command (the toolbar's brush), applied to the selection the
 * person makes next. Marks the source lacks are cleared; links stay.
 */
export const FormatPaste = Extension.create({
  name: 'formatPaste',
  addCommands() {
    return {
      pasteFormat:
        (format) =>
        ({ state, chain }) => {
          if (state.selection.empty) return false
          let c = toList(chain(), listKind(state.selection.$from), format.list)
          // A list item's first block is always a paragraph.
          const { type, level } = format.block
          if (format.list === 'none') c = type === 'heading' && level ? c.setNode('heading', { level }) : type === 'codeBlock' ? c.setNode('codeBlock') : c.setNode('paragraph')
          return c
            .command(({ tr }) => {
              const { from, to } = tr.selection
              tr.doc.nodesBetween(from, to, (node, pos) => {
                if (!INDENTABLE.has(node.type.name)) return !node.isTextblock
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: format.block.textAlign, indent: format.list === 'none' ? format.block.indent : node.attrs.indent })
                return false
              })
              for (const mark of Object.values(tr.doc.type.schema.marks)) if (mark.name !== 'link') tr.removeMark(from, to, mark)
              for (const m of format.marks) {
                const mark = tr.doc.type.schema.marks[m.type]
                if (mark) tr.addMark(from, to, mark.create(m.attrs))
              }
              return true
            })
            .run()
        },
    }
  },
})

/**
 * An image's width in CSS pixels, set by dragging a corner handle (imageResize.ts); null is its
 * natural size, capped by the box. Tiptap's own attribute would keep "50%" or "auto" as text.
 * 0.4.3 has the same attribute name, so it keeps and draws the width (test/olderVersions.test.ts).
 */
/** A drag only stores places inside the box; one from elsewhere (an agent, a bad sync) that is not is drawn in the text. */
const MAX_FLOAT = 100_000
const isPlaced = (attrs: Record<string, unknown>): attrs is { x: number; y: number } =>
  [attrs.x, attrs.y].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_FLOAT)

const floatAttr = (el: HTMLElement, name: string): number | null => {
  const value = el.getAttribute(name) ?? ''
  return /^\d+$/.test(value) ? Number(value) : null
}

const SizedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const width = el.getAttribute('width') ?? ''
          return /^\d+$/.test(width) && Number(width) > 0 ? Number(width) : null
        },
        renderHTML: (attrs) => (typeof attrs.width === 'number' ? { width: String(attrs.width) } : {}),
      },
      // Where the picture was dragged to in its box (dragMove.ts), in pixels from the content's
      // top-left; null is in the text. Read back only from Slate's own data-x/data-y: a paste never
      // places a picture, and a copy (stripCopiedStyles) carries it as a picture in the text.
      x: {
        default: null,
        parseHTML: (el) => floatAttr(el, 'data-x'),
        renderHTML: (attrs) =>
          isPlaced(attrs) ? { 'data-x': String(attrs.x), style: `position: absolute; left: ${attrs.x}px; top: ${attrs.y}px` } : {},
      },
      y: {
        default: null,
        parseHTML: (el) => floatAttr(el, 'data-y'),
        renderHTML: (attrs) => (isPlaced(attrs) ? { 'data-y': String(attrs.y) } : {}),
      },
    }
  },
})

/**
 * Every box editor uses exactly this extension list, so the static renderer's schema matches.
 * Undo/redo is handled per page by Loro (PageSession), not by TipTap history.
 * No Typography extension: no smart quotes or dash replacement.
 */
export function buildExtensions(opts: { autoBullets?: boolean } = {}): Extensions {
  return [
    StarterKit.configure({
      undoRedo: false,
      codeBlock: false,
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
      link: { autolink: false, linkOnPaste: false, openOnClick: false },
    }),
    ListStyle,
    EmptyLineStyle,
    TextStyle,
    AdaptiveColor,
    FontFamily,
    FontSize,
    AdaptiveHighlight.configure({ multicolor: true }),
    // A pasted data-URL picture is stored first (storeDataImages); one that slips past is dropped, never kept in the page.
    SizedImage.configure({ inline: false, allowBase64: false }),
    TableKit.configure({ table: { resizable: false } }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
    // --- autoBullets (WP-H) ---
    ...(opts.autoBullets === false ? [] : [AutoBullets]),
    // --- WP-C1 ---
    TodoList,
    TextAlignment,
    VerticalAlignment,
    // --- WP-C2 ---
    Indent,
    MoveBlocks,
    FormatPaste,
  ]
}

export const schema = getSchema(buildExtensions())
