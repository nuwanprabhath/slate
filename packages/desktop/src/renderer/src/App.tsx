import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { TreeItem } from '@slate/core'
import { activeEditor, EditorServicesContext, type EditorServices } from '@slate/editor'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/api'
import { currentSession } from './currentSession'
import { Library } from './library'
import { PageView } from './PageView'

function firstPage(items: TreeItem[]): TreeItem | undefined {
  for (const item of items) {
    if (item.kind === 'page') return item
    const found = firstPage(item.children)
    if (found) return found
  }
  return undefined
}

export function useMenuCommands(setSettings: (s: Settings) => void): void {
  useEffect(
    () =>
      window.slate.onMenu((command) => {
        const el = document.activeElement
        const inField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        switch (command.cmd) {
          case 'undo':
            if (inField) document.execCommand('undo')
            else currentSession.get()?.undo()
            break
          case 'redo':
            if (inField) document.execCommand('redo')
            else currentSession.get()?.redo()
            break
          case 'paste-plain':
            void window.slate.clipboardText().then((text) => {
              const editor = activeEditor.get()
              if (inField) document.execCommand('insertText', false, text)
              else if (editor?.isFocused) editor.view.pasteText(text)
            })
            break
          case 'settings-changed':
            setSettings(command.settings)
            break
        }
      }),
    [setSettings],
  )
}

export function useServices(settings: Settings): EditorServices {
  return useMemo(
    () => ({
      putBlob: (bytes, mime) => window.slate.blobs.put(bytes, mime),
      copyImage: (url) => window.slate.blobs.copyImage(url),
      readClipboardText: () => window.slate.clipboardText(),
      markdownShortcuts: settings.markdownShortcuts,
    }),
    [settings.markdownShortcuts],
  )
}

export function App() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  useEffect(() => {
    void Library.load(window.slate).then(setLibrary)
    void window.slate.settings.get().then(setSettings)
  }, [])
  useMenuCommands(setSettings)
  const services = useServices(settings)
  if (!library) return <div className="app-loading">Loading…</div>
  return (
    <EditorServicesContext.Provider value={services}>
      <Interim library={library} />
    </EditorServicesContext.Provider>
  )
}

function Interim({ library }: { library: Library }) {
  useSyncExternalStore(library.subscribe, library.getVersion)
  const page = firstPage(library.notebooks()[0].doc.items())
  return <main className="app-main">{page?.pageId && <PageView key={page.pageId} pageId={page.pageId} />}</main>
}
