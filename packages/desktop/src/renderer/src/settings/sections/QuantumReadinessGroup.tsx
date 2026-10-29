import { useCallback, useEffect, useState } from 'react'
import type { PqReadiness } from '../../../../shared/api'
import { errorText, openEncryptWizard } from '../../vault/events'
import { CHECK_NOW, checkStatusText, quantumReadinessText, type CheckState, type SyncTarget } from './quantumReadinessText'

/** Settings → Security: how far each part of Slate's protection is against a future quantum computer (phase 14, PQ-D1). */
export function QuantumReadinessGroup({ onClose, onUpgrade }: { onClose: () => void; onUpgrade: () => void }) {
  const [readiness, setReadiness] = useState<PqReadiness | null>(null)
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' })
  const [sync, setSync] = useState<SyncTarget | null>(null)
  const readSync = useCallback(() => {
    window.slate.sync
      .status()
      .then((s) => setSync({ enabled: s.enabled, provider: s.provider, ...(s.remote !== undefined ? { remote: s.remote } : {}) }))
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    void window.slate.vault
      .pqReadiness()
      .then(setReadiness)
      .catch(() => setReadiness(null))
    readSync()
  }, [readSync])
  const checkNow = useCallback(() => {
    setCheck({ kind: 'busy' })
    readSync()
    window.slate.sync
      .checkTransport()
      .then((transports) => {
        setReadiness((r) => (r ? { ...r, transports } : r))
        setCheck({ kind: 'done', found: transports.length })
      })
      .catch((e: unknown) => setCheck({ kind: 'error', message: errorText(e) }))
  }, [readSync])
  if (!readiness) return null
  const text = quantumReadinessText(readiness)
  const status = checkStatusText(check, { sync, transports: readiness.transports })
  return (
    <fieldset className="settings-group" data-testid="security-pq">
      <legend>Post-quantum readiness</legend>
      <dl className="security-module pq-readiness">
        {text.rows.map((row) => (
          <div key={row.id} data-testid={`security-pq-${row.id}`}>
            <dt>{row.label}</dt>
            <dd>
              <span className="pq-value" title={row.value}>
                {row.value}
              </span>
              {row.help && <span className="pq-help">{row.help}</span>}
              {row.id === 'vault' && text.vaultAction && (
                <>
                  {' '}
                  <button type="button" className="btn" data-testid="security-pq-upgrade" onClick={onUpgrade}>
                    {text.vaultAction}
                  </button>
                </>
              )}
            </dd>
          </div>
        ))}
        <div data-testid="security-pq-sync">
          <dt>Sync connection</dt>
          <dd>
            {text.transports.length > 0 && (
              <ul className="pq-remotes">
                {text.transports.map((t) => (
                  <li key={t.remote}>
                    <span>{t.remote}</span>
                    <span>{t.text}</span>
                    <span className="pq-help">{t.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="pq-check">
              <button type="button" className="btn" data-testid="security-pq-check" disabled={check.kind === 'busy'} onClick={checkNow}>
                {check.kind === 'busy' ? 'Checking…' : CHECK_NOW}
              </button>
              <span className="pq-help" role="status" aria-live="polite" data-testid="security-pq-check-status">
                {status}
              </span>
            </div>
          </dd>
        </div>
      </dl>
      {text.notice && (
        <div className="security-sandbox-notice" role="note" data-testid="security-pq-notice">
          <p className="settings-help">{text.notice.text}</p>
          <button
            type="button"
            className="btn"
            data-testid="security-pq-encrypt"
            onClick={() => {
              onClose()
              openEncryptWizard()
            }}
          >
            {text.notice.action}
          </button>
        </div>
      )}
    </fieldset>
  )
}
