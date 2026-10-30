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
    Image.configure({ inline: false, allowBase64: false }),
    TableKit.configure({ table: { resizable: false } }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
    // --- autoBullets (WP-H) ---
    ...(opts.autoBullets === false ? [] : [AutoBullets]),
    // --- WP-C1 ---
    TodoList,
    TextAlignment,
    VerticalAlignment,
  ]
}

export const schema = getSchema(buildExtensions())
