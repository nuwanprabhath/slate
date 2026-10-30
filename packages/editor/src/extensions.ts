import { Extension, getSchema, InputRule, type Extensions } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { Plugin } from '@tiptap/pm/state'
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
  ]
}

export const schema = getSchema(buildExtensions())
