import type { SectionProps } from '../registry'

export function GeneralSection({ onShowConnectAgents }: SectionProps) {
  return (
    <div className="settings-row">
      <span>
        <strong>AI agents</strong>
        <span className="settings-help">Agents see only the notebooks, sections and pages you allow: right-click one → AI access.</span>
      </span>
      <button type="button" className="settings-button" data-testid="settings-connect-agents" onClick={onShowConnectAgents}>
        Connect AI agents…
      </button>
    </div>
  )
}
