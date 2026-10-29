import { useCallback, useEffect, useState } from 'react'
import type { PqReadiness } from '../../../../shared/api'
import { errorText, openEncryptWizard } from '../../vault/events'
import { CHECK_NOW, quantumReadinessText } from './quantumReadinessText'

/** Settings → Security: how far each part of Slate's protection is against a future quantum computer (phase 14, PQ-D1). */
export function QuantumReadinessGroup({ onClose, onUpgrade }: { onClose: () => void; onUpgrade: () => void }) {
  const [readiness, setReadiness] = useState<PqReadiness | null>(null)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    void window.slate.vault
      .pqReadiness()
      .then(setReadiness)
      .catch(() => setReadiness(null))
  }, [])
  const checkNow = useCallback(() => {
    setChecking(true)
    setMessage('')
    window.slate.sync
      .checkTransport()
      .then((transports) => setReadiness((r) => (r ? { ...r, transports } : r)))
      .catch((e: unknown) => setMessage(errorText(e)))
      .finally(() => setChecking(false))
  }, [])
  if (!readiness) return null
  const text = quantumReadinessText(readiness)
  return (
    <fieldset className="settings-group" data-testid="security-pq">
      <legend>Post-quantum readiness</legend>
      <dl className="security-module pq-readiness">
        {text.rows.map((row) => (
          <div key={row.id} data-testid={`security-pq-${row.id}`}>
            <dt>{row.label}</dt>
            <dd>
              {row.value}
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
            {text.transports.length === 0 ? (
              <span>Not checked</span>
            ) : (
              <ul className="pq-remotes">
                {text.transports.map((t) => (
                  <li key={t.remote}>
                    <span>{t.remote}</span>
                    <span>{t.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="btn" data-testid="security-pq-check" disabled={checking} onClick={checkNow}>
              {checking ? 'Checking…' : CHECK_NOW}
            </button>
            {message && <span className="vault-hint">{message}</span>}
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
