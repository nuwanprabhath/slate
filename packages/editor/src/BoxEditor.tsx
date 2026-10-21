import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { loroSyncPluginKey } from 'loro-prosemirror'
import type { BoxState } from '@slate/core'
import { activeEditor } from './activeEditor'
import { buildExtensions } from './extensions'
import { SlateKeymap } from './keymap'
import { LoroBinding } from './loroBinding'
import type { PageSession } from './PageSession'
import { useEditorServices } from './services'

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
      },
      onUpdate: ({ transaction }) => {
        // Transactions from loro-prosemirror (initial load, remote changes, undo) carry its meta.
        if (!transaction.getMeta(loroSyncPluginKey)) session.noteLocalEdit(box.id)
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
