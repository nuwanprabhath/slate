import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { NotebookDoc, TreeItem } from '@slate/core'
import { findBar } from '../find/FindBar'
import { previewer, replaceInNotes } from '../find/notesReplace'
import type { Library } from '../library'
import type { Selection } from '../selection'
import { builtinPlugins } from './builtins'
import { SEARCH_OPEN_COMMAND } from './ids'
import { PluginRegistry } from './registry'
import type { AppApi, LibraryNotebook, LibrarySection, PluginView } from './types'

const isMac = navigator.platform.toLowerCase().includes('mac')

interface HostState {
  library: Library
  notebookId: string
  /** The page on screen, or null when none is selected. */
  pageId: string | null
  setSelection: (s: Selection) => void
  libraryPanel: () => ReactNode
}

/** Sections in tree order, including those inside section groups. */
function sectionItems(items: TreeItem[]): TreeItem[] {
  return items.flatMap((i) => (i.kind === 'section' ? [i] : i.kind === 'sectionGroup' ? sectionItems(i.children) : []))
}

function sectionsOf(nb: NotebookDoc): LibrarySection[] {
  return sectionItems(nb.items()).map((s) => ({
    id: s.id,
    name: s.title,
    pages: s.children.flatMap((p) => (p.kind === 'page' && p.pageId ? [{ pageId: p.pageId, title: p.title }] : [])),
  }))
}

/** The section and tree item holding a page doc, wherever it sits in the notebook. */
function locate(nb: NotebookDoc, pageId: string): { sectionId: string; itemId: string } | null {
  for (const section of sectionItems(nb.items())) {
    const page = section.children.find((p) => p.pageId === pageId)
    if (page) return { sectionId: section.id, itemId: page.id }
  }
  return null
}

/**
 * Activates the built-in plugins once per workspace and wires them to the app: the plugin API
 * reads the latest state through a ref, Cmd/Ctrl+Shift+F and the like go through the registry's
 * keydown dispatcher, and Edit → Find in Notes… runs the Search command.
 */
export function usePlugins(host: HostState, onShowView: (viewId: string) => void): PluginView[] {
  const latest = useRef(host)
  latest.current = host
  const [registry] = useState(() => {
    const app: AppApi = {
      getLibrary: (): LibraryNotebook[] => latest.current.library.notebooks().map((e) => ({ id: e.id, name: e.doc.name, sections: sectionsOf(e.doc) })),
      currentNotebookId: () => latest.current.notebookId,
      search: (query) => window.slate.search.query(query),
      previewReplacements: previewer(window.slate.docs),
      replaceInPages: (request) =>
        replaceInNotes(request, { persistence: window.slate.docs, exists: (pageId) => latest.current.library.notebooks().some((e) => locate(e.doc, pageId) !== null) }),
      openPage(pageId, options) {
        for (const entry of latest.current.library.notebooks()) {
          const at = locate(entry.doc, pageId)
          if (!at) continue
          latest.current.setSelection({ notebookId: entry.id, sectionId: at.sectionId, pageId: at.itemId })
          const h = options?.highlight
          if (h) findBar.openWith(h.query, h.options, h.boxId ? { pageId, boxId: h.boxId, occurrence: h.occurrence ?? 0 } : null)
          return
        }
      },
    }
    const r = new PluginRegistry(app, {
      get: async () => (await window.slate.settings.get()).plugins ?? {},
      set: async (plugins) => void (await window.slate.settings.set({ plugins })),
    })
    for (const plugin of builtinPlugins({ libraryPanel: () => latest.current.libraryPanel() })) r.activate(plugin)
    return r
  })
  const showView = useRef(onShowView)
  showView.current = onShowView
  useEffect(() => registry.onShowView((id) => showView.current(id)), [registry])
  useEffect(() => registry.attachKeybindings(window, isMac), [registry])
  useEffect(() => window.slate.onMenu((c) => c.cmd === 'find-in-notes' && registry.runCommand(SEARCH_OPEN_COMMAND)), [registry])
  useEffect(() => {
    if (host.pageId !== null) registry.pageOpened(host.pageId)
  }, [registry, host.pageId])
  // Locking tears this renderer down, so `pagehide` is the last moment a plugin gets either way.
  useEffect(() => {
    const onHide = () => registry.willLock()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [registry])
  return useSyncExternalStore(registry.subscribe, registry.views)
}
