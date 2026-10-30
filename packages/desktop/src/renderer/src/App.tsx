import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { activeEditor, EditorServicesContext, openLinkPopover, pastePlainOrLink, type EditorServices } from '@slate/editor'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/api'
import { ActivityBar } from './activity/ActivityBar'
import { toolsFromViews } from './activity/tools'
import { usePlugins } from './plugins/usePlugins'
import { AiActivity } from './AiActivity'
import { clampPane, clampWidth, loadLayout, loadLibraryBox, paneWidth, saveLayout, saveLibraryBox, scaleExpanded, type Layout } from './layout'
import { Column, Rail, Splitter } from './Splitter'
import { currentSession } from './currentSession'
import { ConnectAgents } from './ConnectAgents'
import { findBar } from './find/FindBar'
import { ImportDialog } from './import/ImportDialog'
import { Library, syncSettled } from './library'
import { PageView } from './PageView'
import { printPage } from './print'
import { loadSelection, saveSelection, type Selection } from './selection'
import { NotebookPicker } from './sidebar/NotebookPicker'
import { PageList } from './sidebar/PageList'
import { SectionList } from './sidebar/SectionList'
import { onOpenSettings, openSettings } from './settings/open'
import { SettingsDialog } from './settings/SettingsDialog'
import { providerName, syncStateText, useSyncState } from './sync/SyncStatus'
import { TitleBar } from './titleBar/TitleBar'
import { Toolbar } from './Toolbar'
import { findItem, firstOfKind } from './treeUtils'
import { UpdateBanner } from './update/UpdateBanner'

export function useMenuCommands(setSettings: (s: Settings) => void, onShowAiActivity: () => void, onShowImport: () => void, onShowConnectAgents: () => void, onShowBackupImport: () => void): void {
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
              else if (editor?.isFocused) pastePlainOrLink(editor.view, text)
            })
            break
          case 'link':
            openLinkPopover(activeEditor.get())
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
          case 'show-import-backup':
            onShowBackupImport()
            break
          case 'show-connect-agents':
            onShowConnectAgents()
            break
          case 'find':
            findBar.open()
            break
          case 'show-settings':
            openSettings(command.section)
            break
          case 'find-in-notes':
            // The search plugin listens for this one (plugins/usePlugins.ts).
            break
          case 'print':
            void printPage('print')
            break
          case 'export-pdf':
            void printPage('pdf')
            break
        }
      }),
    [setSettings, onShowAiActivity, onShowImport, onShowConnectAgents, onShowBackupImport],
  )
}

export function useServices(settings: Settings): EditorServices {
  return useMemo(
    () => ({
      putBlob: (bytes, mime) => window.slate.blobs.put(bytes, mime),
      copyImage: (url) => window.slate.blobs.copyImage(url),
      copyRich: (text, html) => window.slate.blobs.copyRich(text, html),
      readClipboardText: () => window.slate.clipboardText(),
      markdownShortcuts: settings.markdownShortcuts,
      autoBullets: settings.autoBullets,
      linkPastedUrls: settings.linkPastedUrls,
      openExternal: (url) => window.slate.openExternal(url),
    }),
    [settings.markdownShortcuts, settings.autoBullets, settings.linkPastedUrls],
  )
}

const noSubscribe = () => () => {}
const noVersion = () => 0

/**
 * `banners`: the vault, migration and quick-unlock banners (main.tsx). They go under the title bar,
 * inside the shell's height: above it they sat under the traffic lights and pushed the window's
 * bottom edge out of view.
 */
export function App({ banners }: { banners?: ReactNode }) {
  const [library, setLibrary] = useState<Library | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  useEffect(() => {
    void Library.load(window.slate).then(setLibrary)
    void window.slate.settings.get().then(setSettings)
    return window.slate.settings.onChange(setSettings)
  }, [])
  // null: closed; otherwise the section to open on.
  const [settingsOpen, setSettingsOpen] = useState<{ section?: string } | null>(null)
  useEffect(() => onOpenSettings((section) => setSettingsOpen({ section })), [])
  // The menu accelerator handles a real keypress; this catches the key when the menu did not see it
  // (a focused box editor on some platforms, synthetic input in tests). Opening twice is harmless.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ',' || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      openSettings()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
  const closeSettings = useCallback(() => setSettingsOpen(null), [])
  const [aiActivity, setAiActivity] = useState(false)
  const showAiActivity = useCallback(() => setAiActivity(true), [])
  const [importOpen, setImportOpen] = useState<false | 'graph' | 'backup'>(false)
  const showImport = useCallback(() => setImportOpen('graph'), [])
  const showBackupImport = useCallback(() => setImportOpen('backup'), [])
  const closeImport = useCallback(() => setImportOpen(false), [])
  const [connectOpen, setConnectOpen] = useState(false)
  const showConnectAgents = useCallback(() => setConnectOpen(true), [])
  const closeConnectAgents = useCallback(() => setConnectOpen(false), [])
  useMenuCommands(setSettings, showAiActivity, showImport, showConnectAgents, showBackupImport)
  const services = useServices(settings)
  // Re-renders when the first notebook arrives, to swap the waiting state for the workspace.
  useSyncExternalStore(library?.subscribe ?? noSubscribe, library?.getVersion ?? noVersion)
  if (!library) return <div className="app-loading">Loading…</div>
  if (library.isEmpty())
    return (
      <>
        {banners}
        <WaitingForNotebooks library={library} />
      </>
    )
  return (
    <EditorServicesContext.Provider value={services}>
      <Workspace library={library} onShowImport={showImport} banners={banners} />
      {aiActivity && <AiActivity onClose={() => setAiActivity(false)} />}
      {importOpen && <ImportDialog onClose={closeImport} initial={importOpen} />}
      {connectOpen && <ConnectAgents onClose={closeConnectAgents} />}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          section={settingsOpen.section}
          onClose={closeSettings}
          onShowConnectAgents={() => {
            closeSettings()
            showConnectAgents()
          }}
        />
      )}
      <Notices />
    </EditorServicesContext.Provider>
  )
}

/**
 * A device with no notebooks yet. With sync off at start-up it gets the default notebook at once;
 * with sync on it waits, so notebooks from other devices arrive instead of a new empty one.
 */
function WaitingForNotebooks({ library }: { library: Library }) {
  const state = useSyncState()
  const [syncOn, setSyncOn] = useState<boolean | null>(null)
  useEffect(() => {
    void window.slate.sync.status().then((s) => {
      setSyncOn(s.enabled)
      if (!s.enabled) void library.settle()
    })
  }, [library])
  useEffect(
    () =>
      window.slate.onExternalUpdates((batches) => {
        for (const { docId, updates } of batches) if (docId.startsWith('notebook:')) library.importExternal(docId.slice('notebook:'.length), updates)
      }),
    [library],
  )
  useEffect(() => {
    if (syncOn && state && syncSettled(state)) void library.settle()
  }, [library, syncOn, state])
  if (!syncOn) return <div className="app-loading">Loading…</div>
  return (
    <div className="empty" data-testid="waiting-for-sync" role="status">
      <p>Waiting for your notebooks from {providerName(state)}…</p>
      <p data-testid="waiting-sync-state">{state ? syncStateText(state) : 'Starting sync…'}</p>
    </div>
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

function Workspace({ library, onShowImport, banners }: { library: Library; onShowImport: () => void; banners: ReactNode }) {
  useSyncExternalStore(library.subscribe, library.getVersion)
  const [selection, setSelection] = useState<Selection>(loadSelection)
  const notebooks = library.notebooks()
  const entry = notebooks.find((n) => n.id === selection.notebookId) ?? notebooks[0]!
  const items = entry.doc.items()
  const sectionCandidate = findItem(items, selection.sectionId)
  const section = sectionCandidate?.kind === 'section' ? sectionCandidate : firstOfKind(items, 'section')
  const pages = section?.children.filter((c) => c.kind === 'page') ?? []
  const page = pages.find((p) => p.id === selection.pageId) ?? pages[0]

  useEffect(() => {
    saveSelection({ notebookId: entry.id, sectionId: section?.id ?? null, pageId: page?.id ?? null })
  }, [entry.id, section?.id, page?.id])

  useEffect(() => void window.slate.sync.opened(entry.id), [entry.id])
  useEffect(() => window.slate.sync.onOpenNotebook((id) => setSelection({ notebookId: id, sectionId: null, pageId: null })), [])

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

  // Last measured Library geometry: the Search view takes its total width, and a manual Search
  // width is scaled back onto the two columns (see scaleColumns).
  // Remembered across restarts, so an app that starts in the Search view already knows the width.
  const libraryBox = useRef(loadLibraryBox())
  useLayoutEffect(() => {
    if (!layout.panelOpen || layout.activeTool !== 'library') return
    const aside = document.querySelector<HTMLElement>('[data-testid="library-panel"]')
    if (!aside) return
    const measure = () => {
      const width = (id: string) => aside.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().width ?? 0
      libraryBox.current = { total: aside.getBoundingClientRect().width, sections: width('sections-column'), pages: width('pages-column') }
      saveLibraryBox(libraryBox.current)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(aside)
    return () => observer.disconnect()
  }, [layout.panelOpen, layout.activeTool])
  // The Library's own splitters win over a manual Search width, so the two views stay the same width.
  const setLibraryWidth = (key: 'sectionsWidth' | 'pagesWidth', w: number | null) =>
    setLayout((l) => ({ ...l, [key]: w === null ? null : clampWidth(w), searchWidth: null }))
  const setCollapsed = (key: 'sectionsCollapsed' | 'pagesCollapsed', value: boolean) => setLayout((l) => ({ ...l, [key]: value }))
  const resizeSearch = (w: number | null) =>
    setLayout((l) => {
      if (w === null) return { ...l, searchWidth: null }
      const box = libraryBox.current
      // The splitter measures the pane to its left; the pane's own splitter is 1 px more.
      const total = clampPane(w + 1, window.innerWidth)
      // A collapsed column keeps its stored width; only expanded columns take the new one.
      const [sections, pages] = scaleExpanded(box.sections, box.pages, total - (box.total - box.sections - box.pages), l.sectionsCollapsed, l.pagesCollapsed)
      return {
        ...l,
        searchWidth: total,
        sectionsWidth: sections === null ? l.sectionsWidth : clampWidth(sections),
        pagesWidth: pages === null ? l.pagesWidth : clampWidth(pages),
      }
    })
  const sidePane = (panel: ReactNode) => (
    <div className="side-pane" style={{ width: paneWidth(layout.searchWidth, libraryBox.current.total, window.innerWidth) }}>
      {panel}
      <Splitter testId="splitter-search" label="Resize search" width={layout.searchWidth} onChange={resizeSearch} />
    </div>
  )

  const libraryPanel = () => (
    <aside className="sidebar" data-testid="library-panel">
      {/* Both columns hidden: the pane is just the two rails, so the picker's width does not hold it open. */}
      {!(layout.sectionsCollapsed && layout.pagesCollapsed) && (
      <NotebookPicker
        library={library}
        current={entry}
        onSelect={(id) => setSelection({ notebookId: id, sectionId: null, pageId: null })}
        onImport={onShowImport}
      />
      )}
      <div className="sidebar-cols">
        {layout.sectionsCollapsed ? (
          <Rail testId="sections-column" buttonTestId="expand-sections" label="Show sections" onExpand={() => setCollapsed('sectionsCollapsed', false)} />
        ) : (
        <Column testId="sections-column" width={layout.sectionsWidth}>
          <SectionList
            nb={entry.doc}
            items={items}
            selectedSectionId={section?.id ?? null}
            onSelect={(id) => setSelection({ notebookId: entry.id, sectionId: id, pageId: null })}
            onDeleted={removeDocs}
          />
        </Column>
        )}
        {!layout.sectionsCollapsed && (
          <Splitter
            testId="splitter-sections"
            label="Resize sections"
            width={layout.sectionsWidth}
            onChange={(w) => setLibraryWidth('sectionsWidth', w)}
            collapse={{ label: 'Hide sections', testId: 'collapse-sections', onCollapse: () => setCollapsed('sectionsCollapsed', true) }}
          />
        )}
        {layout.pagesCollapsed ? (
          <Rail testId="pages-column" buttonTestId="expand-pages" label="Show pages" onExpand={() => setCollapsed('pagesCollapsed', false)} />
        ) : (
        <Column testId="pages-column" width={layout.pagesWidth}>
          <PageList
            nb={entry.doc}
            section={section}
            selectedPageId={page?.id ?? null}
            onSelect={(id) => setSelection({ notebookId: entry.id, sectionId: section?.id ?? null, pageId: id })}
            onDeleted={removeDocs}
          />
        </Column>
        )}
        {!layout.pagesCollapsed && (
          <Splitter
            testId="splitter-pages"
            label="Resize pages"
            width={layout.pagesWidth}
            onChange={(w) => setLibraryWidth('pagesWidth', w)}
            collapse={{ label: 'Hide pages', testId: 'collapse-pages', onCollapse: () => setCollapsed('pagesCollapsed', true) }}
          />
        )}
      </div>
    </aside>
  )
  const showView = useCallback((id: string) => setLayout((l) => ({ ...l, activeTool: id, panelOpen: true })), [])
  const tools = toolsFromViews(usePlugins({ library, notebookId: entry.id, setSelection, libraryPanel }, showView))
  const activeTool = tools.find((t) => t.id === layout.activeTool) ?? tools[0]!

  return (
    <div className="app-shell">
      <TitleBar title={page ? `${page.title || 'Untitled page'} — ${entry.doc.name}` : entry.doc.name} />
      {banners}
      <div className="app">
        <ActivityBar tools={tools} activeId={activeTool.id} panelOpen={layout.panelOpen} onSelect={selectTool} />
        {layout.panelOpen && (activeTool.id === 'library' ? activeTool.panel() : sidePane(activeTool.panel()))}
        <main className="app-main">
          <UpdateBanner />
          <Toolbar />
          {page?.pageId ? <PageView key={page.pageId} nb={entry.doc} item={page} /> : <div className="empty">No page selected</div>}
        </main>
      </div>
    </div>
  )
}
