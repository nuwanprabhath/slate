import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { activeEditor, EditorServicesContext, type EditorServices } from '@slate/editor'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/api'
import { ActivityBar } from './activity/ActivityBar'
import { createTools } from './activity/tools'
import { AiActivity } from './AiActivity'
import { clampWidth, loadLayout, saveLayout, type Layout } from './layout'
import { Splitter } from './Splitter'
import { currentSession } from './currentSession'
import { ConnectAgents } from './ConnectAgents'
import { ImportDialog } from './import/ImportDialog'
import { Library } from './library'
import { PageView } from './PageView'
import { loadSelection, saveSelection, type Selection } from './selection'
import { NotebookPicker } from './sidebar/NotebookPicker'
import { PageList } from './sidebar/PageList'
import { SectionList } from './sidebar/SectionList'
import { SyncStatus } from './sync/SyncStatus'
import { Toolbar } from './Toolbar'
import { findItem, firstOfKind } from './treeUtils'

export function useMenuCommands(setSettings: (s: Settings) => void, onShowAiActivity: () => void, onShowImport: () => void, onShowConnectAgents: () => void): void {
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
          case 'show-import':
            onShowImport()
            break
          case 'show-connect-agents':
            onShowConnectAgents()
            break
        }
      }),
    [setSettings, onShowAiActivity, onShowImport, onShowConnectAgents],
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
  const [importOpen, setImportOpen] = useState(false)
  const showImport = useCallback(() => setImportOpen(true), [])
  const closeImport = useCallback(() => setImportOpen(false), [])
  const [connectOpen, setConnectOpen] = useState(false)
  const showConnectAgents = useCallback(() => setConnectOpen(true), [])
  const closeConnectAgents = useCallback(() => setConnectOpen(false), [])
  useMenuCommands(setSettings, showAiActivity, showImport, showConnectAgents)
  const services = useServices(settings)
  if (!library) return <div className="app-loading">Loading…</div>
  return (
    <EditorServicesContext.Provider value={services}>
      <Workspace library={library} onShowImport={showImport} />
      {aiActivity && <AiActivity onClose={() => setAiActivity(false)} />}
      {importOpen && <ImportDialog onClose={closeImport} />}
      {connectOpen && <ConnectAgents onClose={closeConnectAgents} />}
      <Notices />
    </EditorServicesContext.Provider>
  )
}

/** Sync's notices (a box restored because it was edited here) as a dismissible toast. */
function Notices() {
  const [messages, setMessages] = useState<string[]>([])
  useEffect(() => window.slate.sync.onNotice((m) => setMessages((all) => [...all, m])), [])
  if (messages.length === 0) return null
  return (
    <div className="notice" data-testid="notice" role="status">
      <span>{messages[0]}</span>
      <button type="button" aria-label="Dismiss" data-testid="notice-dismiss" onClick={() => setMessages((all) => all.slice(1))}>
        ×
      </button>
    </div>
  )
}

function Workspace({ library, onShowImport }: { library: Library; onShowImport: () => void }) {
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

  useEffect(
    () =>
      window.slate.onExternalUpdates((batches) => {
        for (const { docId, updates } of batches) {
          if (docId.startsWith('notebook:')) library.importExternal(docId.slice('notebook:'.length), updates)
          const session = currentSession.get()
          if (session && docId === `page:${session.pageId}`) session.importExternal(updates)
        }
      }),
    [library],
  )

  const removeDocs = (pageIds: string[]) => void library.removePageDocs(pageIds)

  const [layout, setLayout] = useState<Layout>(loadLayout)
  useEffect(() => saveLayout(layout), [layout])
  const togglePanel = useCallback(() => setLayout((l) => ({ ...l, panelOpen: !l.panelOpen })), [])
  const selectTool = (id: string) =>
    setLayout((l) => (id === l.activeTool ? { ...l, panelOpen: !l.panelOpen } : { ...l, activeTool: id, panelOpen: true }))
  // Capture phase so it also fires inside a box editor, before ProseMirror can insert a backslash.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '\\' || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      togglePanel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [togglePanel])

  const tools = createTools(() => (
    <aside className="sidebar" data-testid="library-panel">
      <NotebookPicker
        library={library}
        current={entry}
        onSelect={(id) => setSelection({ notebookId: id, sectionId: null, pageId: null })}
        onImport={onShowImport}
      />
      <div className="sidebar-cols">
        <div className="column" data-testid="sections-column" style={{ width: layout.sectionsWidth }}>
          <SectionList
            nb={entry.doc}
            items={items}
            selectedSectionId={section?.id ?? null}
            onSelect={(id) => setSelection({ notebookId: entry.id, sectionId: id, pageId: null })}
            onDeleted={removeDocs}
          />
        </div>
        <Splitter testId="splitter-sections" label="Resize sections" width={layout.sectionsWidth} onChange={(w) => setLayout((l) => ({ ...l, sectionsWidth: clampWidth(w) }))} />
        <div className="column" data-testid="pages-column" style={{ width: layout.pagesWidth }}>
          <PageList
            nb={entry.doc}
            section={section}
            selectedPageId={page?.id ?? null}
            onSelect={(id) => setSelection({ notebookId: entry.id, sectionId: section?.id ?? null, pageId: id })}
            onDeleted={removeDocs}
          />
        </div>
        <Splitter testId="splitter-pages" label="Resize pages" width={layout.pagesWidth} onChange={(w) => setLayout((l) => ({ ...l, pagesWidth: clampWidth(w) }))} />
      </div>
    </aside>
  ))
  const activeTool = tools.find((t) => t.id === layout.activeTool) ?? tools[0]

  return (
    <div className="app">
      <ActivityBar tools={tools} activeId={activeTool.id} panelOpen={layout.panelOpen} onSelect={selectTool} bottom={<SyncStatus />} />
      {layout.panelOpen && activeTool.panel()}
      <main className="app-main">
        <Toolbar />
        {page?.pageId ? <PageView key={page.pageId} nb={entry.doc} item={page} /> : <div className="empty">No page selected</div>}
      </main>
    </div>
  )
}
