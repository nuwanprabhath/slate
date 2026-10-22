import { Extension, getSchema, InputRule, type Extensions } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
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
          return {
            'data-color': color,
            style: `background-color: ${readableHighlight(color, currentTheme().text)}; color: inherit`,
          }
        },
      },
    }
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
    TextStyle,
    AdaptiveColor,
    FontFamily,
    FontSize,
    AdaptiveHighlight.configure({ multicolor: true }),
    Image.configure({ inline: false, allowBase64: true }),
    TableKit.configure({ table: { resizable: false } }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
    // --- autoBullets (WP-H) ---
    ...(opts.autoBullets === false ? [] : [AutoBullets]),
  ]
}

export const schema = getSchema(buildExtensions())
