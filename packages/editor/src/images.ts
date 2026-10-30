import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { mayHoldImages, makeClipboardSerializer, serializeSliceAsText, storeDataImages } from './clipboard'
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

/**
 * Other apps cannot load slate-blob:// addresses. A clicked image goes onto the clipboard as a
 * picture; a selection with images in it as text and HTML, main embedding each image's bytes.
 * A selection without images is left to the editor's own copy.
 */
export function copyWithImages(view: EditorView, event: ClipboardEvent, services: Pick<EditorServices, 'copyImage' | 'copyRich'>): boolean {
  const { selection } = view.state
  if (selection instanceof NodeSelection && selection.node.type.name === 'image') {
    event.preventDefault()
    void services.copyImage(String(selection.node.attrs.src))
  } else {
    if (selection.empty) return false
    const slice = selection.content()
    let images = false
    slice.content.descendants((node) => !(images ||= node.type.name === 'image'))
    if (!images) return false
    event.preventDefault()
    const holder = document.createElement('div')
    holder.appendChild(makeClipboardSerializer(view.state.schema).serializeFragment(slice.content))
    void services.copyRich(serializeSliceAsText(slice), holder.innerHTML)
  }
  if (event.type === 'cut') view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'))
  return true
}

/** Pastes HTML, first storing any picture embedded in it. */
export function pasteHtml(view: EditorView, html: string, putBlob: EditorServices['putBlob']): void {
  if (!mayHoldImages(html)) {
    view.pasteHTML(html)
    return
  }
  void storeDataImages(html, putBlob).then((stored) => {
    if (!view.isDestroyed) view.pasteHTML(stored)
  })
}
