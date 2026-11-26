import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type Settings, type UpdateState } from '../../../../shared/api'
import { askConsent } from '../../privacy/askConsent'
import { withConsent } from '../../privacy/withConsent'
import { describeCheck, formatChecked } from '../../update/describeCheck'
import '../../update/update.css'

/** Check-interval presets, in hours. */
const INTERVAL_PRESETS = [1, 6, 12, 24]

/** For the Settings registry: the dialog lists this section and searches its label, blurb and keywords. */
export const updatesSectionEntry = {
  id: 'updates',
  label: 'Updates',
  blurb: 'How Slate keeps itself up to date.',
  keywords: ['version', 'release', 'install'],
}

/** Reads and writes its own settings and update state, so the dialog can mount it with no props. */
export function UpdatesSection() {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  // `egressAllowed(settings, 'updates')` as main computes it: strict mode off, or a current grant.
  const [allowed, setAllowed] = useState(true)

  useEffect(() => {
    const refreshAllowed = () => void window.slate.privacy.status().then((p) => setAllowed(p.allowed.updates), () => {})
    const off = window.slate.update.onState(setUpdate)
    const offSettings = window.slate.settings.onChange((s) => {
      setSettings(s)
      refreshAllowed()
    })
    void window.slate.update.state().then((s) => setUpdate((current) => current ?? s))
    void window.slate.settings.get().then(setSettings)
    refreshAllowed()
    return () => {
      off()
      offSettings()
    }
  }, [])

  const save = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    void window.slate.settings.set(patch)
  }
  const check = () => {
    setChecking(true)
    setResult(null)
    // The answer is what the call resolves with, not the pushed state: that may have arrived already.
    void withConsent('updates', () => window.slate.update.check(), { askFirst: false })
      .then((answer) => {
        if (answer === null) return setResult('Not checked: you have not allowed Slate to contact GitHub.')
        setResult(describeCheck(answer.value))
      })
      .catch((e: unknown) => setResult(`Could not check: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setChecking(false))
  }

  const busy = checking || update?.phase === 'checking' || update?.phase === 'downloading' || update?.phase === 'installing' || update?.phase === 'restarting'
  const hours = settings.updateCheckIntervalHours
  const intervals = INTERVAL_PRESETS.includes(hours) ? INTERVAL_PRESETS : [...INTERVAL_PRESETS, hours].sort((a, b) => a - b)

  return (
    <div className="updates-section" data-testid="updates-section">
      <p className="updates-version">
        <strong data-testid="update-version">Version {update?.currentVersion ?? '—'}</strong>
        <br />
        <span data-testid="update-last-checked">Last checked: {formatChecked(update?.lastCheckedAt)}</span>
        {update?.reason && (
          <>
            <br />
            <span data-testid="update-reason">{update.reason}</span>
          </>
        )}
        {update?.skippedVersion && (
          <>
            <br />
            <span data-testid="update-skipped">Skipping {update.skippedVersion}. A newer release is still offered.</span>{' '}
            <button type="button" data-testid="update-unskip" onClick={() => void window.slate.update.unskip()}>
              Stop skipping
            </button>
          </>
        )}
      </p>
      <div className="updates-check">
        <button type="button" data-testid="update-check-now" disabled={busy} onClick={check}>
          {busy ? 'Checking…' : 'Check now'}
        </button>
        {result && <span data-testid="update-check-result">{result}</span>}
      </div>
      <label className="updates-field">
        <input
          type="checkbox"
          data-testid="setting-update-automatic"
          checked={settings.updateAutomaticChecks && allowed}
          onChange={(e) => {
            if (!e.target.checked) return save({ updateAutomaticChecks: false })
            if (allowed) return save({ updateAutomaticChecks: true })
            void askConsent('updates').then((answer) => {
              if (answer !== 'granted') return
              setAllowed(true)
              save({ updateAutomaticChecks: true })
            })
          }}
        />
        Check for updates automatically
      </label>
      <p className="updates-help settings-indent">Slate asks github.com whether there is a newer release (a download comes from objects.githubusercontent.com). That tells GitHub, Inc. (USA) your IP address, Slate&rsquo;s version and your operating system. Nothing is downloaded or installed without you saying so.</p>
      {settings.updateAutomaticChecks && allowed && (
        <label className="updates-field settings-indent">
          Every
          <select data-testid="setting-update-interval" value={hours} onChange={(e) => save({ updateCheckIntervalHours: Number(e.target.value) })}>
            {intervals.map((h) => (
              <option key={h} value={h}>
                {h} {h === 1 ? 'hour' : 'hours'}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
