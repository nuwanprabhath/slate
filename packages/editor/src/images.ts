import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { EditorServices } from './services'

/** Image files on the clipboard. Ignored when there is text too (Office apps add a picture of copied text). */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data || data.getData('text/plain').trim() !== '') return []
  return Array.from(data.files).filter((f) => f.type.startsWith('image/'))
}

export function insertImages(view: EditorView, files: File[], putBlob: EditorServices['putBlob']): void {
  void (async () => {
    for (const file of files) {
      const src = await putBlob(new Uint8Array(await file.arrayBuffer()), file.type)
      if (view.isDestroyed) return
      const { image, paragraph } = view.state.schema.nodes
      const tr = view.state.tr.replaceSelectionWith(image!.create({ src }))
      // Leave a text caret after the image: a selection beside a block node is drawn as a blinking gap-cursor line.
      const end = tr.selection.to
      if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, paragraph!.create())
      view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1)).scrollIntoView())
    }
  })()
}

/** Copying a selected image puts real image data on the clipboard, not an <img> pointing at slate-blob://. */
export function copySelectedImage(view: EditorView, event: ClipboardEvent, copyImage: EditorServices['copyImage']): boolean {
  const { selection } = view.state
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return false
  event.preventDefault()
  void copyImage(String(selection.node.attrs.src))
  return true
}
