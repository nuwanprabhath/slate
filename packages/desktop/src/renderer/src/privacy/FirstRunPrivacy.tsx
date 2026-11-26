import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { DISCLOSURES, type ConsentFeature } from '../../../shared/privacy/consent'
import type { PrivacyStatus, Settings } from '../../../shared/api'
import { errorText } from '../vault/events'
import { openSettings } from '../settings/open'
import { askConsent } from './askConsent'
import './firstRun.css'

/** The e2e hook asks the card to look again (testHooks.ts `showFirstRunPrivacy`). */
export const FIRST_RUN_RECHECK = 'slate:first-run-recheck'

/** Existing specs run with the card off: e2e hooks are installed, and the card waits for `slateTest.firstRunPrivacy`. */
function suppressedByTestHooks(): boolean {
  const hooks = (window as unknown as { slateTest?: { firstRunPrivacy?: boolean } }).slateTest
  return hooks !== undefined && hooks.firstRunPrivacy !== true
}

/** The setting that remembers either answer (`settings.plugins`, free-form). */
export const FIRST_RUN_KEY = 'firstRunPrivacy'

/**
 * The first-run privacy card (GDPR-01): nothing is sent anywhere until the person turns it on. Not a modal, so
 * it never blocks the notes. Shown while strict mode has no `updates` consent and the card has not been
 * answered; a different card (Keep / Withdraw) lists any feature an existing install keeps by `legacy` grant.
 * Each claim below is what `egressAllowed(settings, 'updates')` and the update gate do; main enforces it.
 */
export function FirstRunPrivacy() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<PrivacyStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState('')
  const [, recheck] = useState(0)
  const card = useRef<HTMLElement>(null)

  const load = useCallback(() => {
    void Promise.all([window.slate.settings.get(), window.slate.privacy.status()]).then(([s, p]) => {
      setSettings(s)
      setStatus(p)
    }, () => {})
  }, [])
  useEffect(load, [load])
  useEffect(() => {
    const again = () => {
      setDismissed(false)
      recheck((n) => n + 1)
      load()
    }
    window.addEventListener(FIRST_RUN_RECHECK, again)
    return () => window.removeEventListener(FIRST_RUN_RECHECK, again)
  }, [load])

  if (settings === null || status === null || dismissed || suppressedByTestHooks()) return null
  const legacy = status.legacy
  const seen = settings.plugins[FIRST_RUN_KEY] === 'seen'
  const firstRun = legacy.length === 0 && status.gdprStrictMode && !status.consents.updates && !seen
  if (legacy.length === 0 && !firstRun) return null

  const markSeen = async () => {
    const fresh = await window.slate.settings.get()
    setSettings(await window.slate.settings.set({ plugins: { ...fresh.plugins, [FIRST_RUN_KEY]: 'seen' } }))
  }
  const fail = (e: unknown) => setError(errorText(e))

  const turnOnUpdates = async () => {
    setError('')
    try {
      if ((await askConsent('updates')) !== 'granted') return
      await window.slate.settings.set({ updateAutomaticChecks: true })
      await markSeen()
      setDismissed(true)
    } catch (e) {
      fail(e)
    }
  }
  const noThanks = async () => {
    setError('')
    try {
      await markSeen()
      setDismissed(true)
    } catch (e) {
      fail(e)
    }
  }
  const decide = async (f: ConsentFeature, keep: boolean) => {
    setError('')
    try {
      const next = keep ? await window.slate.privacy.grant(f) : await window.slate.privacy.revoke(f)
      setStatus(next)
    } catch (e) {
      fail(e)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (firstRun) void noThanks()
    else setDismissed(true)
  }

  return (
    <section ref={card} className="first-run" data-testid="first-run-privacy" role="region" aria-labelledby="first-run-title" onKeyDown={onKeyDown}>
      {firstRun ? (
        <>
          <h2 id="first-run-title">Your notes stay here</h2>
          <p>Slate keeps your notes on this computer. Nothing is sent anywhere unless you turn it on.</p>
          <label className="first-run-toggle">
            <input type="checkbox" data-testid="first-run-updates" checked={false} onChange={() => void turnOnUpdates()} />
            <span>Check for updates automatically (asks github.com; sends your IP address and Slate&rsquo;s version)</span>
          </label>
          <p className="first-run-error" role="alert">{error}</p>
          <div className="first-run-actions">
            <button type="button" className="btn" data-testid="first-run-settings" onClick={() => openSettings('privacy')}>
              Settings → Privacy
            </button>
            <button type="button" className="btn" data-testid="first-run-dismiss" onClick={() => void noThanks()}>
              No thanks
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 id="first-run-title">Review your privacy settings</h2>
          <p>Slate now asks before it sends anything off this computer. You had these on already; keep each one or withdraw it.</p>
          <ul className="first-run-legacy" data-testid="first-run-legacy">
            {legacy.map((f) => (
              <li key={f} data-testid={`first-run-legacy-${f}`}>
                <span>{DISCLOSURES[f].title}</span>
                <span className="first-run-buttons">
                  <button type="button" className="btn primary" onClick={() => void decide(f, true)}>
                    Keep
                  </button>
                  <button type="button" className="btn" onClick={() => void decide(f, false)}>
                    Withdraw
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <p className="first-run-error" role="alert">{error}</p>
          <div className="first-run-actions">
            <button type="button" className="btn" data-testid="first-run-settings" onClick={() => openSettings('privacy')}>
              Settings → Privacy
            </button>
            <button type="button" className="btn" data-testid="first-run-later" onClick={() => setDismissed(true)}>
              Later
            </button>
          </div>
        </>
      )}
    </section>
  )
}
