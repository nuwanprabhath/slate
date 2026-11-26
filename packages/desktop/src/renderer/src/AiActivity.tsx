import { useEffect, useState } from 'react'
import type { AuditEntryRow } from '../../shared/api'
import { errorText } from './vault/events'

const OUTCOME_TEXT: Record<string, string> = { ok: 'allowed', denied: 'denied', 'not-found': 'not found' }

export function AiActivity({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<AuditEntryRow[] | null>(null)
  useEffect(() => {
    void window.slate.audit.list(200).then(setRows)
  }, [])
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirming) setConfirming(false)
      else onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose, confirming])
  const clear = () => {
    setError('')
    window.slate.privacy.auditClear().then(
      () => {
        setRows([])
        setConfirming(false)
      },
      (e: unknown) => setError(errorText(e)),
    )
  }
  return (
    <div className="ai-activity-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="ai-activity" data-testid="ai-activity" role="dialog" aria-label="AI Activity">
        <header>
          <h2>AI Activity</h2>
          <span className="ai-activity-tools">
            {confirming ? (
              <span className="ai-activity-confirm" data-testid="ai-activity-confirm">
                <span>Delete this record? It cannot be undone.</span>
                <button type="button" className="btn danger" data-testid="ai-activity-clear-confirm" onClick={clear}>
                  Delete
                </button>
                <button type="button" className="btn" data-testid="ai-activity-clear-cancel" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="btn" data-testid="ai-activity-clear" disabled={rows === null || rows.length === 0} onClick={() => setConfirming(true)}>
                Clear
              </button>
            )}
            <button type="button" data-testid="ai-activity-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </span>
        </header>
        {error && (
          <p className="ai-activity-error" role="alert">
            {error}
          </p>
        )}
        {rows === null ? null : rows.length === 0 ? (
          <p className="empty">No AI activity yet. Agents see nothing until you share a notebook, section or page (right-click → AI access).</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Tool</th>
                <th>Target</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="ai-activity-row" className={r.outcome === 'ok' ? undefined : 'refused'}>
                  <td>{new Date(r.ts).toLocaleString()}</td>
                  <td>{r.tool}</td>
                  <td className="target">{r.target}</td>
                  <td>{OUTCOME_TEXT[r.outcome] ?? r.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
