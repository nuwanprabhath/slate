import { useEffect, useRef, useState } from 'react'
import type { SyncState } from '../../../shared/api'
import { SyncSettings } from './SyncSettings'
import { syncAgeText } from './syncAge'
import './sync.css'

const LABELS: Record<SyncState['status'], string> = {
  'idle-synced': 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  error: 'Sync error',
  'signed-out': 'Signed out',
  disabled: 'Sync is off',
}

/** "OneDrive", "GitHub" or "your git repository": where this device syncs to. */
export function providerName(state: Pick<SyncState, 'provider' | 'remote'> | null): string {
  if (state?.provider === 'git') return /github\.com[:/]/.test(state.remote ?? '') ? 'GitHub' : 'your git repository'
  return 'OneDrive'
}

function statusLabel(state: SyncState | null): string {
  const status = state?.status ?? 'disabled'
  return status === 'idle-synced' && state?.provider ? `Synced to ${providerName(state)}` : LABELS[status]
}

export function lastSyncedText(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return 'Never synced'
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'Last synced just now'
  if (minutes < 60) return `Last synced ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `Last synced ${hours} h ago` : `Last synced ${new Date(at).toLocaleDateString()}`
}

export function syncStateText(state: SyncState): string {
  return [statusLabel(state), state.message, lastSyncedText(state.lastSyncedAt)].filter(Boolean).join(' · ')
}

export function useSyncState(): SyncState | null {
  const [state, setState] = useState<SyncState | null>(null)
  useEffect(() => {
    let live = false
    const off = window.slate.sync.onStatus((s) => {
      live = true
      setState(s)
    })
    // An event that arrives first is newer than this answer.
    void window.slate.sync.status().then((s) => live || setState(s))
    return off
  }, [])
  return state
}

/** A cloud with a badge per state; the syncing arrows hold still under reduced motion (sync.css). */
function CloudIcon({ status, setUp }: { status: SyncState['status']; setUp: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 15.5h8a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 4.7 9.6 3 3 0 0 0 6 15.5Z" />
      {!setUp && <path d="M10 9.5v4M8 11.5h4" />}
      {setUp && status === 'idle-synced' && <path d="M7.5 11.5l1.8 1.8 3.4-3.6" />}
      {setUp && status === 'syncing' && (
        <g className="sync-arrows">
          <path d="M7.5 11a2.5 2.5 0 0 1 4.3-1.6M12.5 12a2.5 2.5 0 0 1-4.3 1.6" />
        </g>
      )}
      {setUp && status === 'offline' && <path d="M3 3l14 14" />}
      {setUp && status === 'error' && <path d="M10 9.5v2.5M10 14h.01" />}
    </svg>
  )
}

export function SyncStatus() {
  const state = useSyncState()
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Set from the click until the report arrives, so the icon doesn't wait for the status event.
  const [running, setRunning] = useState(false)
  const [, tick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const setUp = state?.enabled ?? false
  const status = running ? 'syncing' : (state?.status ?? 'disabled')
  const label = running ? LABELS.syncing : statusLabel(state)
  const last = lastSyncedText(state?.lastSyncedAt)
  const age = setUp ? syncAgeText(state?.lastSyncedAt) : ''
  const busy = status === 'syncing'
  const tooltip = !setUp
    ? 'Sync is not set up · Click to set up'
    : [label, status === 'error' ? state?.message : '', last, busy ? '' : 'Click to sync now'].filter(Boolean).join(' · ')

  const syncNow = () => {
    if (busy || !setUp) return
    setRunning(true)
    void window.slate.sync.now().finally(() => setRunning(false))
  }

  return (
    <div className="sync-status-wrap" ref={ref}>
      <button
        type="button"
        className={`sync-status sync-${setUp ? status : 'disabled'}`}
        data-testid="sync-status"
        data-state={status}
        aria-label={tooltip}
        title={tooltip}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (setUp ? syncNow() : setSettingsOpen(true))}
        onContextMenu={(e) => {
          e.preventDefault()
          setOpen((o) => !o)
        }}
      >
        <CloudIcon status={status} setUp={setUp} />
        {age && (
          <span className="sync-age" data-testid="sync-age">
            {age}
          </span>
        )}
      </button>
      <button
        type="button"
        className="sync-chevron"
        data-testid="sync-menu"
        aria-label="Sync details"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        ▾
      </button>
      {open && (
        <div className="sync-popover" data-testid="sync-popover" role="dialog" aria-label="Sync">
          <div className="sync-popover-status">{label}</div>
          {state?.status === 'error' && state.message && <div className="sync-popover-detail">{state.message}</div>}
          <div className="sync-popover-detail">{last}</div>
          {state?.account && <div className="sync-popover-detail">{state.account}</div>}
          {state?.remote && <div className="sync-popover-detail">{state.remote}</div>}
          <div className="sync-popover-actions">
            <button type="button" data-testid="sync-now" disabled={!setUp || busy} onClick={syncNow}>
              Sync now
            </button>
            <button type="button" data-testid="sync-toggle" onClick={() => void window.slate.sync.setEnabled(!state?.enabled)}>
              {state?.enabled ? 'Turn off sync' : 'Turn on sync'}
            </button>
          </div>
          <button
            type="button"
            className="sync-popover-link"
            data-testid="sync-settings-open"
            onClick={() => {
              setOpen(false)
              setSettingsOpen(true)
            }}
          >
            Sync settings…
          </button>
        </div>
      )}
      {settingsOpen && <SyncSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
