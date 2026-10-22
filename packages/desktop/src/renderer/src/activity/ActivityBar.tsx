import type { ReactNode } from 'react'
import type { ActivityTool } from './tools'

const isMac = navigator.platform.toLowerCase().includes('mac')

interface Props {
  tools: ActivityTool[]
  activeId: string
  panelOpen: boolean
  onSelect: (id: string) => void
  /** Status items pinned under the tools, at the bar's foot. */
  bottom?: ReactNode
}

export function ActivityBar({ tools, activeId, panelOpen, onSelect, bottom }: Props) {
  return (
    <div className="activity-bar" data-testid="activity-bar" role="toolbar" aria-orientation="vertical" aria-label="Tools">
      {tools.map((tool) => {
        const pressed = panelOpen && tool.id === activeId
        return (
          <button
            key={tool.id}
            type="button"
            className={pressed ? 'activity-button active' : 'activity-button'}
            data-testid={`activity-${tool.id}`}
            aria-pressed={pressed}
            aria-label={tool.label}
            title={`${tool.label} (${tool.shortcut ?? (isMac ? '⌘\\' : 'Ctrl+\\')})`}
            onClick={() => onSelect(tool.id)}
          >
            {tool.icon}
          </button>
        )
      })}
      {bottom && (
        <div className="activity-bottom" data-testid="activity-bottom">
          {bottom}
        </div>
      )}
    </div>
  )
}
