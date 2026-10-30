import type { ReactNode } from 'react'
import type { FindOptions } from '@slate/editor'
import type { SearchQuery, SearchResults, Settings } from '../../../shared/api'
import type { NotesReplace } from '../find/notesReplace'

/**
 * A plugin sees only its `PluginContext`, never `window.slate`, so a future sandboxed or
 * externally installed plugin can be handed exactly the same interface.
 */
export interface SlatePlugin {
  id: string
  name: string
  activate(ctx: PluginContext): void
}

/** A button on the activity bar and the panel it opens in the side pane. */
export interface PluginView {
  id: string
  title: string
  icon: ReactNode
  /** Lower comes first on the bar. */
  order: number
  /** Shown in the button's tooltip, e.g. "⌘⇧F". */
  shortcut?: string
  render: () => ReactNode
}

export interface PluginCommand {
  id: string
  title: string
  /** `Mod` is Cmd on macOS and Ctrl elsewhere, e.g. `Mod+Shift+F`. */
  keybinding?: string
  run: () => void
}

/** Values live in the settings DB under `plugins.<id>.<key>`. */
export interface PluginSettings {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
}

export interface LibrarySection {
  id: string
  name: string
  pages: Array<{ pageId: string; title: string }>
}

export interface LibraryNotebook {
  id: string
  name: string
  sections: LibrarySection[]
}

/** Find-bar state to open a page with: the query, and which match should be current. */
export interface PageHighlight {
  query: string
  options: FindOptions
  boxId?: string
  /** The match's index within its box. */
  occurrence?: number
}

/** The narrow slice of the app a plugin may use. */
export interface AppApi {
  openPage(pageId: string, options?: { highlight?: PageHighlight }): void
  getLibrary(): LibraryNotebook[]
  currentNotebookId(): string | null
  search(query: SearchQuery): Promise<SearchResults>
  /** Find in Notes' Replace All: the ticked matches, each changed page one undo step. */
  replaceInPages(request: NotesReplace): Promise<{ replaced: number; pages: number }>
}

export interface PluginContext {
  views: { register(view: PluginView): void; show(viewId: string): void }
  commands: { register(command: PluginCommand): void }
  settings: PluginSettings
  app: AppApi
}

/** Where the `plugins` settings record persists: `window.slate.settings` in the app, memory in tests. */
export interface SettingsBackend {
  get(): Promise<NonNullable<Settings['plugins']>>
  /** Replaces the whole record. */
  set(plugins: NonNullable<Settings['plugins']>): Promise<void>
}
