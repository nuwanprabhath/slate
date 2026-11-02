import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/api'
import { openSettings } from '../settings/open'
import { bannerText } from './bannerText'
import { UpdatePasswordForm } from './UpdatePasswordForm'
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
  const { phase } = state
  const downloaded = phase === 'downloaded'
  const assisted = state.kind === 'dmg' || state.kind === 'deb'
  // Once Install and restart is under way nothing else is offered: the banner only says what is happening.
  const busy = phase === 'installing' || phase === 'restarting' || (phase === 'downloading' && state.installRequested === true)
  return (
    <div className="update-banner" data-testid="update-banner" data-phase={phase} role="status">
      <span className="update-banner-text">
        {bannerText(state)}
        {phase === 'needs-password' && (
          <span className="update-banner-note" data-testid="update-password-note">
            {state.kind === 'dmg' ? 'The password you sign in to this Mac with.' : 'Your password for sudo on this computer.'} Used once, never saved.
          </span>
        )}
      </span>
      {phase === 'downloading' && (
        <progress className="update-banner-progress" data-testid="update-progress" max={100} value={state.progress ?? 0} />
      )}
      {phase === 'needs-password' && <UpdatePasswordForm kind={state.kind === 'dmg' ? 'dmg' : 'deb'} />}
      {!busy && phase !== 'needs-password' && (
        <>
          {((phase === 'available' && assisted) || (downloaded && state.installable)) && (
            <button type="button" className="btn primary" data-testid="update-install-restart" onClick={() => void u.prepareInstall()}>
              {state.installError ? 'Try again' : 'Install and restart'}
            </button>
          )}
          {phase === 'available' && (
            <button type="button" data-testid="update-download" onClick={() => void u.download()}>
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
          {phase === 'available' && (
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
        </>
      )}
    </div>
  )
}
