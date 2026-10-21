import { useEffect } from 'react'
import { Extension } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { loroSyncPluginKey } from 'loro-prosemirror'
import type { BoxState } from '@slate/core'
import { activeEditor } from './activeEditor'
import { cleanPastedHtml, makeClipboardSerializer, serializeSliceAsText } from './clipboard'
import { buildExtensions, schema } from './extensions'
import { findHighlightPlugin } from './find'
import { copySelectedImage, imageFilesFrom, insertImages } from './images'
import { SlateKeymap } from './keymap'
import { LoroBinding } from './loroBinding'
import type { PageSession } from './PageSession'
import { useEditorServices } from './services'

const clipboardSerializer = makeClipboardSerializer(schema)

interface Props {
  box: BoxState
  session: PageSession
  autoFocus: boolean
  onFocus: () => void
}

export function BoxEditor({ box, session, autoFocus, onFocus }: Props) {
  const services = useEditorServices()
  const editor = useEditor(
    {
      extensions: [
        ...buildExtensions(),
        LoroBinding.configure({ doc: session.doc, containerId: box.contentId }),
        SlateKeymap.configure({ session, services }),
        Extension.create({ name: 'slateFind', addProseMirrorPlugins: () => [findHighlightPlugin(box.id)] }),
      ],
      enableInputRules: services.markdownShortcuts,
      enablePasteRules: false,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'slate-box-content',
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          'data-testid': 'box-editor',
        },
        clipboardTextSerializer: serializeSliceAsText,
        clipboardSerializer,
        transformPastedHTML: cleanPastedHtml,
        handlePaste: (view, event) => {
          const files = imageFilesFrom(event.clipboardData)
          if (files.length === 0) return false
          event.preventDefault()
          insertImages(view, files, services.putBlob)
          return true
        },
        handleDOMEvents: {
          copy: (view, event) => copySelectedImage(view, event, services.copyImage),
        },
      },
      onUpdate: ({ transaction }) => {
        // Transactions from loro-prosemirror (initial load, remote changes, undo) carry its meta.
        if (transaction.getMeta(loroSyncPluginKey)) session.noteRemoteEdit(box.id)
        else session.noteLocalEdit(box.id)
      },
      onFocus: ({ editor: e }) => {
        activeEditor.set(e)
        onFocus()
      },
      onBlur: ({ editor: e }) => {
        if (e.isEmpty) session.page.deleteBox(box.id)
      },
    },
    [box.contentId, services.markdownShortcuts],
  )
  useEffect(
    () => () => {
      if (editor) activeEditor.clear(editor)
    },
    [editor],
  )
  return <EditorContent editor={editor} />
}
