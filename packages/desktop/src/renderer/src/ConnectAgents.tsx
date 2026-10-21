import { useEffect, useState } from 'react'

export function ConnectAgents({ onClose }: { onClose: () => void }) {
  const [claudeCommand, setClaudeCommand] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.slate.mcp.launcherInfo().then((info) => setClaudeCommand(info.claudeCommand))
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const copy = async () => {
    if (!claudeCommand) return
    await navigator.clipboard.writeText(claudeCommand)
    setCopied(true)
  }
  return (
    <div className="ai-activity-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="ai-activity" data-testid="connect-agents" role="dialog" aria-label="Connect AI agents">
        <header>
          <h2>Connect AI agents</h2>
          <button type="button" data-testid="connect-agents-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p>Slate shares nothing until you allow it: right-click a notebook, section or page → AI access.</p>
        <pre className="connect-command" data-testid="connect-agents-command">{claudeCommand ?? ''}</pre>
        <button type="button" data-testid="connect-agents-copy" disabled={!claudeCommand} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <p className="empty">Other MCP clients: use this command as a stdio server.</p>
      </section>
    </div>
  )
}
