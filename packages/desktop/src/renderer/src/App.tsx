import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { activeEditor, EditorServicesContext, type EditorServices } from '@slate/editor'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/api'
import { AiActivity } from './AiActivity'
import { currentSession } from './currentSession'
import { Library } from './library'
import { PageView } from './PageView'
import { loadSelection, saveSelection, type Selection } from './selection'
import { NotebookPicker } from './sidebar/NotebookPicker'
import { PageList } from './sidebar/PageList'
import { SectionList } from './sidebar/SectionList'
import { Toolbar } from './Toolbar'
import { findItem, firstOfKind } from './treeUtils'

export function useMenuCommands(setSettings: (s: Settings) => void, onShowAiActivity: () => void): void {
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
          case 'show-ai-activity':
            onShowAiActivity()
            break
        }
      }),
    [setSettings, onShowAiActivity],
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
  const [aiActivity, setAiActivity] = useState(false)
  const showAiActivity = useCallback(() => setAiActivity(true), [])
  useMenuCommands(setSettings, showAiActivity)
  const services = useServices(settings)
  if (!library) return <div className="app-loading">Loading…</div>
  return (
    <EditorServicesContext.Provider value={services}>
      <Workspace library={library} />
      {aiActivity && <AiActivity onClose={() => setAiActivity(false)} />}
    </EditorServicesContext.Provider>
  )
}

function Workspace({ library }: { library: Library }) {
  useSyncExternalStore(library.subscribe, library.getVersion)
  const [selection, setSelection] = useState<Selection>(loadSelection)
  const notebooks = library.notebooks()
  const entry = notebooks.find((n) => n.id === selection.notebookId) ?? notebooks[0]
  const items = entry.doc.items()
  const sectionCandidate = findItem(items, selection.sectionId)
  const section = sectionCandidate?.kind === 'section' ? sectionCandidate : firstOfKind(items, 'section')
  const pages = section?.children.filter((c) => c.kind === 'page') ?? []
  const page = pages.find((p) => p.id === selection.pageId) ?? pages[0]

  useEffect(() => {
    saveSelection({ notebookId: entry.id, sectionId: section?.id ?? null, pageId: page?.id ?? null })
  }, [entry.id, section?.id, page?.id])

  const removeDocs = (pageIds: string[]) => void library.removePageDocs(pageIds)

  return (
    <div className="app">
      <aside className="sidebar">
        <NotebookPicker library={library} current={entry} onSelect={(id) => setSelection({ notebookId: id, sectionId: null, pageId: null })} />
        <div className="sidebar-cols">
          <SectionList
            nb={entry.doc}
            items={items}
            selectedSectionId={section?.id ?? null}
            onSelect={(id) => setSelection({ notebookId: entry.id, sectionId: id, pageId: null })}
            onDeleted={removeDocs}
          />
          <PageList
            nb={entry.doc}
            section={section}
            selectedPageId={page?.id ?? null}
            onSelect={(id) => setSelection({ notebookId: entry.id, sectionId: section?.id ?? null, pageId: id })}
            onDeleted={removeDocs}
          />
        </div>
      </aside>
      <main className="app-main">
        <Toolbar />
        {page?.pageId ? <PageView key={page.pageId} nb={entry.doc} item={page} /> : <div className="empty">No page selected</div>}
      </main>
    </div>
  )
}
