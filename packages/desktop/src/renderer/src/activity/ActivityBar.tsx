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
          <svg data-icon="gear" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8.6 2.5h2.8l.4 1.9 1.2.5 1.6-1.1 2 2-1.1 1.6.5 1.2 1.9.4v2.8l-1.9.4-.5 1.2 1.1 1.6-2 2-1.6-1.1-1.2.5-.4 1.9H8.6l-.4-1.9-1.2-.5-1.6 1.1-2-2 1.1-1.6-.5-1.2-1.9-.4V8.6l1.9-.4.5-1.2-1.1-1.6 2-2 1.6 1.1 1.2-.5Z" />
            <circle cx="10" cy="10" r="2.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
