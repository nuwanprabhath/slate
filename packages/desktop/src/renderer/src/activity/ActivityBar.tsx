import type { ReactNode } from 'react'
import { openSettings } from '../settings/open'
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
      <div className="activity-bottom" data-testid="activity-bottom">
        {bottom}
        <button
          type="button"
          className="activity-button"
          data-testid="activity-settings"
          aria-label="Settings"
          title={`Settings (${isMac ? '⌘,' : 'Ctrl+,'})`}
          onClick={() => openSettings()}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="10" cy="10" r="2.5" />
            <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
          </svg>
        </button>
      </div>
    </div>
  )
}
