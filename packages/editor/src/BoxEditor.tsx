import { useEffect, useSyncExternalStore } from 'react'
import { Extension } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { loroSyncPluginKey } from 'loro-prosemirror'
import type { BoxState } from '@slate/core'
import { activeEditor } from './activeEditor'
import { SlateCaret } from './caret'
import { currentTheme, onThemeChange } from './colorContrast'
import { cleanPastedHtml, hasDataImage, makeClipboardSerializer, serializeSliceAsText } from './clipboard'
import { buildExtensions, schema } from './extensions'
import { findHighlightPlugin } from './find'
import { copyWithImages, imageFilesFrom, insertImages, pasteHtml } from './images'
import { ImageSelection } from './imageSelection'
import { SlateKeymap } from './keymap'
import { LinkPopover } from './LinkPopover'
import { isSingleUrl, PastedLinks, pastePlainOrLink } from './links'
import { LoroBinding } from './loroBinding'
import type { PageSession } from './PageSession'
import { useEditorServices } from './services'
import { editorRuleOptions } from './inputRules'

const clipboardSerializer = makeClipboardSerializer(schema)

interface Props {
  box: BoxState
  session: PageSession
  autoFocus: boolean
  onFocus: () => void
}

export function BoxEditor({ box, session, autoFocus, onFocus }: Props) {
  const services = useEditorServices()
  // Mark colours are adapted to the theme when rendered, so a theme switch rebuilds the editor.
  const theme = useSyncExternalStore(onThemeChange, currentTheme)
  const editor = useEditor(
    {
      extensions: [
        ...buildExtensions({ autoBullets: services.autoBullets }),
        LoroBinding.configure({ doc: session.doc, containerId: box.contentId }),
        SlateKeymap.configure({ session, services }),
        SlateCaret,
        ImageSelection,
        PastedLinks.configure({ enabled: services.linkPastedUrls }),
        Extension.create({ name: 'slateFind', addProseMirrorPlugins: () => [findHighlightPlugin(box.id)] }),
      ],
      ...editorRuleOptions(services),
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
          const url = event.clipboardData?.getData('text/plain') ?? ''
          if (!view.state.selection.empty && isSingleUrl(url)) {
            event.preventDefault()
            pastePlainOrLink(view, url)
            return true
          }
          const html = event.clipboardData?.getData('text/html') ?? ''
          if (hasDataImage(html)) {
            event.preventDefault()
            pasteHtml(view, html, services.putBlob)
            return true
          }
          const files = imageFilesFrom(event.clipboardData)
          if (files.length === 0) return false
          event.preventDefault()
          insertImages(view, files, services.putBlob)
          return true
        },
        handleClick: (_view, _pos, event) => {
          const anchor = (event.target as HTMLElement).closest('a[href]')
          if (!anchor) return false
          // Editing never navigates; Mod+click opens through the main process.
          event.preventDefault()
          if (event.metaKey || event.ctrlKey) void services.openExternal(anchor.getAttribute('href') ?? '')
          return event.metaKey || event.ctrlKey
        },
        handleDOMEvents: {
          mouseover: (_view, event) => {
            const anchor = (event.target as HTMLElement).closest?.('a[href]')
            if (anchor && !anchor.hasAttribute('title')) anchor.setAttribute('title', 'Mod+click to open')
            return false
          },
          copy: (view, event) => copyWithImages(view, event, services),
          cut: (view, event) => copyWithImages(view, event, services),
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
      onBlur: () => {
        session.deleteIfEmpty(box.id)
      },
    },
    [box.contentId, services.markdownShortcuts, services.autoBullets, services.linkPastedUrls, theme],
  )
  useEffect(
    () => () => {
      if (editor) activeEditor.clear(editor)
    },
    [editor],
  )
  return (
    <>
      <EditorContent editor={editor} />
      <LinkPopover editor={editor} />
    </>
  )
}
