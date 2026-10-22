import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/api'
import { openSettings } from '../settings/open'
import './update.css'

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [copied, setCopied] = useState<'command' | 'notes' | null>(null)
  useEffect(() => {
    const off = window.slate.update.onState(setState)
    void window.slate.update.state().then((s) => setState((current) => current ?? s))
    return off
  }, [])
  if (!state?.visible || !state.version) return null
  const u = window.slate.update
  const copy = (what: 'command' | 'notes') => {
    void (what === 'command' ? u.copyCommand() : u.copyReleaseUrl()).then(() => setCopied(what))
  }
  const downloaded = state.phase === 'downloaded'
  return (
    <div className="update-banner" data-testid="update-banner" role="status">
      <span className="update-banner-text">
        {downloaded ? `Slate ${state.version} is downloaded` : `Slate ${state.version} is available`}
        {state.phase === 'available' && state.currentVersion && ` · you are on ${state.currentVersion}`}
        {state.phase === 'downloading' && ` · downloading ${state.progress ?? 0}%`}
        {downloaded && state.kind === 'dmg' && ' · drag Slate into Applications'}
      </span>
      {state.phase === 'downloading' && (
        <progress className="update-banner-progress" data-testid="update-progress" max={100} value={state.progress ?? 0} />
      )}
      {state.phase === 'available' && (
        <button type="button" onClick={() => void u.download()}>
          {state.kind === 'auto' ? 'Download and install' : 'Download'}
        </button>
      )}
      {downloaded && state.kind === 'auto' && (
        <button type="button" onClick={() => void u.install()}>
          Restart and install
        </button>
      )}
      {downloaded && state.file && (
        <>
          <button type="button" onClick={() => void u.openInstaller()}>
            Open installer
          </button>
          <button type="button" onClick={() => void u.showInFolder()}>
            Show in folder
          </button>
        </>
      )}
      {downloaded && state.command && (
        <button type="button" data-testid="update-copy-command" title={state.command} onClick={() => copy('command')}>
          {copied === 'command' ? 'Copied' : 'Copy install command'}
        </button>
      )}
      <button type="button" className="update-banner-link" title={state.releaseUrl} onClick={() => copy('notes')}>
        {copied === 'notes' ? 'Link copied' : 'Release notes'}
      </button>
      {state.phase === 'available' && (
        <button type="button" className="update-banner-link" onClick={() => void u.skip()}>
          Skip this version
        </button>
      )}
      <button
        type="button"
        className="update-banner-link"
        data-testid="update-settings"
        onClick={() => openSettings('updates')}
      >
        Update settings
      </button>
      <button type="button" className="update-banner-close" aria-label="Dismiss" data-testid="update-dismiss" onClick={() => void u.dismiss()}>
        ×
      </button>
    </div>
  )
}
