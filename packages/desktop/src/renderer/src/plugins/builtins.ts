import type { ReactNode } from 'react'
import { createLibraryPlugin } from './library/libraryPlugin'
import { createSearchPlugin } from './search/searchPlugin'
import type { SlatePlugin } from './types'

export interface BuiltinDeps {
  /** The app's notebooks panel. */
  libraryPanel: () => ReactNode
}

/** Every plugin Slate ships with, activated through the same `PluginRegistry.activate` an external one would use. */
export function builtinPlugins(deps: BuiltinDeps): SlatePlugin[] {
  return [createLibraryPlugin(deps.libraryPanel), createSearchPlugin()]
}
