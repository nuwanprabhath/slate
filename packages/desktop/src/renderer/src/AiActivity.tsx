import { useEffect, useState } from 'react'
import type { AuditEntryRow } from '../../shared/api'

const OUTCOME_TEXT: Record<string, string> = { ok: 'allowed', denied: 'denied', 'not-found': 'not found' }

export function AiActivity({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<AuditEntryRow[] | null>(null)
  useEffect(() => {
    void window.slate.audit.list(200).then(setRows)
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="ai-activity-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="ai-activity" data-testid="ai-activity" role="dialog" aria-label="AI Activity">
        <header>
          <h2>AI Activity</h2>
          <button type="button" data-testid="ai-activity-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
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
