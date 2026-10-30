import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * An image is drawn with contenteditable=false, so Chromium paints no selection highlight on it: a
 * shift+click or drag across one selected it with nothing to show. Images wholly inside a range
 * selection get a class the canvas styles like the clicked image. A clicked image is a node
 * selection and has ProseMirror's own class.
 */
export const ImageSelection = Extension.create({
  name: 'imageSelection',
  addProseMirrorPlugins: () => [
    new Plugin({
      props: {
        decorations: (state) => {
          const { selection, doc } = state
          if (selection.empty || selection instanceof NodeSelection) return null
          const found: Decoration[] = []
          doc.nodesBetween(selection.from, selection.to, (node, pos) => {
            if (node.type.name === 'image' && pos >= selection.from && pos + node.nodeSize <= selection.to)
              found.push(Decoration.node(pos, pos + node.nodeSize, { class: 'slate-image-selected' }))
            return !node.isTextblock
          })
          return found.length > 0 ? DecorationSet.create(doc, found) : null
        },
      },
    }),
  ],
})
