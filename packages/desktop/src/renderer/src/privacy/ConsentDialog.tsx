import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { DISCLOSURES, type ConsentFeature } from '../../../shared/privacy/consent'
import { ExternalLink } from '../ExternalLink'
import { errorText } from '../vault/events'
import { onConsentRequest, type ConsentAlternative, type ConsentRequest } from './askConsent'
import './privacy.css'

export const PRIVACY_NOTICE_URL = 'https://github.com/nuwanprabhath/slate/blob/main/PRIVACY.md'

export interface ConsentDialogProps {
  feature: ConsentFeature
  /** `granted` is true only after main recorded the grant (`privacy.grant`). */
  onDone(granted: boolean): void
  /** Shown as the main action instead of Allow; the dialog then closes with `onDone(false)`. */
  primaryAlternative?: ConsentAlternative
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The consent step before a feature sends data off this computer (GDPR review §3.1 step 9): what it
 * contacts, what it sends and who receives it, from `DISCLOSURES`. Focus stays inside; Escape is Not now.
 */
export function ConsentDialog({ feature, onDone, primaryAlternative }: ConsentDialogProps) {
  const d = DISCLOSURES[feature]
  const dialog = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    dialog.current?.focus()
  }, [])

  const allow = async () => {
    setBusy(true)
    setError('')
    try {
      await window.slate.privacy.grant(feature)
      onDone(true)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (!busy) onDone(false)
      return
    }
    if (e.key !== 'Tab' || !dialog.current) return
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === dialog.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="consent-backdrop">
      <section ref={dialog} className="consent-dialog" data-testid="consent-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id="consent-title">{d.title}</h2>
        <p>Slate sends this only after you allow it. You can withdraw it at any time in Settings → Privacy.</p>
        {d.endpoints.length > 0 && (
          <div className="consent-part" data-testid="consent-endpoints">
            <h3>Contacts</h3>
            <ul className="consent-list">
              {d.endpoints.map((host) => (
                <li key={host}>
                  <code>{host}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="consent-part" data-testid="consent-data">
          <h3>Sends</h3>
          <ul className="consent-list">
            {d.data.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="consent-part" data-testid="consent-recipient">
          <h3>Received by</h3>
          <p>{d.recipient}</p>
        </div>
        <p className="consent-hint">
          Read the <ExternalLink href={PRIVACY_NOTICE_URL}>privacy notice</ExternalLink> for how long it is kept and how to turn it off.
        </p>
        <p className="consent-error" role="alert">{error}</p>
        <div className="consent-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => onDone(false)}>
            Not now
          </button>
          <button type="button" className={primaryAlternative ? 'btn' : 'btn primary'} disabled={busy} onClick={() => void allow()}>
            Allow
          </button>
          {primaryAlternative && (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => {
                primaryAlternative.onClick()
                onDone(false)
              }}
            >
              {primaryAlternative.label}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

/** Draws the dialog for each `askConsent` request, one at a time; mounted once in main.tsx. */
export function ConsentHost() {
  const [queue, setQueue] = useState<Array<{ id: number; request: ConsentRequest }>>([])
  const nextId = useRef(0)
  const tookAlternative = useRef(false)
  useEffect(() => onConsentRequest((request) => setQueue((q) => [...q, { id: nextId.current++, request }])), [])
  const current = queue[0]
  if (!current) return null
  const { feature, primaryAlternative, resolve } = current.request
  const done = (granted: boolean) => {
    resolve(granted ? 'granted' : tookAlternative.current ? 'alternative' : 'declined')
    tookAlternative.current = false
    setQueue((q) => q.slice(1))
  }
  const alternative = primaryAlternative && {
    label: primaryAlternative.label,
    onClick: () => {
      tookAlternative.current = true
      primaryAlternative.onClick()
    },
  }
  return <ConsentDialog key={current.id} feature={feature} onDone={done} {...(alternative ? { primaryAlternative: alternative } : {})} />
}
