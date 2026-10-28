import { type JSX, useCallback, useEffect, useState } from 'react'
import type { DiagnosticsStatus } from '../../../../shared/api'

/** For the Settings registry. */
export const diagnosticsSectionEntry = {
  id: 'diagnostics',
  label: 'Diagnostics',
  blurb: 'A log you can switch on when something goes wrong, and send on.',
  keywords: ['log', 'debug', 'bug'],
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Self-contained: reads and writes the `debugLog` setting itself, so the Settings dialog mounts it
 * with no props.
 */
export function DiagnosticsSection(): JSX.Element {
  const [on, setOn] = useState(false)
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null)
  const [note, setNote] = useState('')

  const refresh = useCallback(() => {
    window.slate.diagnostics.status().then(setStatus).catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    window.slate.settings.get().then((s) => setOn(s.debugLog)).catch(() => {})
    refresh()
  }, [refresh])

  const toggle = (checked: boolean) => {
    setOn(checked)
    window.slate.settings.set({ debugLog: checked }).then(refresh).catch(() => setOn(!checked))
  }

  return (
    <div className="settings-stack" data-testid="diagnostics-section">
      <label className="settings-row">
        <input type="checkbox" data-testid="setting-debug-log" checked={on} onChange={(e) => toggle(e.target.checked)} />
        <span>Write a diagnostic log</span>
      </label>
      <p className="settings-help">
        Off by default, and off means nothing is written at all: no folder, no file. Switch it on when something is
        going wrong, reproduce it, then copy the log into a bug report.
      </p>
      <p className="settings-help" data-testid="diagnostics-privacy">
        <strong>What goes in it:</strong> what Slate did &mdash; sync runs and their counts, git failures, update checks,
        imports, errors. <strong>Not</strong> your notes: no page or box text, no page or section titles, no search
        queries. Your home folder is shown as <code>~</code>, and anything shaped like a token or a password is stripped.
      </p>
      <div className="settings-field">
        <strong>Log file</strong>
        <code className="settings-path" data-testid="diagnostics-path">{status?.file ?? ''}</code>
        <span className="settings-help">{status && status.bytes > 0 ? formatBytes(status.bytes) : 'Nothing written yet.'}</span>
      </div>
      <div className="settings-actions">
        <button className="btn" data-testid="diagnostics-open" onClick={() => void window.slate.diagnostics.openFolder()}>
          Open log folder
        </button>
        <button
          className="btn"
          data-testid="diagnostics-copy"
          onClick={() => {
            window.slate.diagnostics.copy().then((n) => setNote(n > 0 ? 'Copied the log.' : 'The log is empty.')).catch(() => setNote('Could not copy the log.'))
          }}
        >
          Copy log
        </button>
        <button
          className="btn danger"
          data-testid="diagnostics-clear"
          onClick={() => {
            window.slate.diagnostics.clear().then(() => { setNote('Cleared.'); refresh() }).catch(() => setNote('Could not clear the log.'))
          }}
        >
          Clear log
        </button>
        <span className="settings-help" role="status" data-testid="diagnostics-note">{note}</span>
      </div>
    </div>
  )
}
