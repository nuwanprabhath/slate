import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type Settings, type UpdateState } from '../../../../shared/api'
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

  useEffect(() => {
    const off = window.slate.update.onState(setUpdate)
    void window.slate.update.state().then((s) => setUpdate((current) => current ?? s))
    void window.slate.settings.get().then(setSettings)
    return off
  }, [])

  const save = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    void window.slate.settings.set(patch)
  }
  const check = () => {
    setChecking(true)
    setResult(null)
    // The answer is what the call resolves with, not the pushed state: that may have arrived already.
    void window.slate.update
      .check()
      .then((state) => setResult(describeCheck(state)))
      .catch((e: unknown) => setResult(`Could not check: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setChecking(false))
  }

  const busy = checking || update?.phase === 'checking' || update?.phase === 'downloading'
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
          checked={settings.updateAutomaticChecks}
          onChange={(e) => save({ updateAutomaticChecks: e.target.checked })}
        />
        Check for updates automatically
      </label>
      <p className="updates-help settings-indent">Slate asks GitHub whether there is a newer release. Nothing is downloaded or installed without you saying so.</p>
      {settings.updateAutomaticChecks && (
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
