import type { ReactNode } from 'react'

export interface ActivityTool {
  id: string
  label: string
  icon: ReactNode
  panel: () => ReactNode
}

/** A rounded rectangle with a divider and two short lines in the left part: a sidebar panel. */
function SidebarPanelIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.5" />
      <path d="M8 3.75v12.5" />
      <path d="M4.75 7.5h1.5M4.75 10h1.5" />
    </svg>
  )
}

/** A future tool is one more entry here plus its panel component. */
export function createTools(library: () => ReactNode): ActivityTool[] {
  return [{ id: 'library', label: 'Notebooks', icon: <SidebarPanelIcon />, panel: library }]
}
