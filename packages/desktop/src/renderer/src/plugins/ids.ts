/**
 * The built-in plugins' view and command ids. Every contribution id carries its plugin's id as a
 * prefix (`PluginRegistry` refuses one that does not), so two plugins can never claim the same id.
 * They are named here because the app shell persists the active view id and opens views by id.
 */
export const LIBRARY_VIEW_ID = 'library.notebooks'
export const SEARCH_VIEW_ID = 'search.panel'
export const SEARCH_OPEN_COMMAND = 'search.open'
