import type { ReactNode } from 'react'
import type { PluginView } from '../plugins/types'

export interface ActivityTool {
  id: string
  label: string
  icon: ReactNode
  /** For the tooltip; the bar's default is the panel toggle, Cmd/Ctrl+\. */
  shortcut?: string
  panel: () => ReactNode
}

/** The activity bar lists the plugins' views (see `plugins/`); a new tool is a new plugin. */
export function toolsFromViews(views: PluginView[]): ActivityTool[] {
  return views.map((v) => ({ id: v.id, label: v.title, icon: v.icon, ...(v.shortcut ? { shortcut: v.shortcut } : {}), panel: v.render }))
}
