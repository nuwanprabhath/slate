import { useEffect, useRef, useState } from 'react'
import type { SyncState } from '../../../shared/api'
import './sync.css'

const LABELS: Record<SyncState['status'], string> = {
  'idle-synced': 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  error: 'Sync error',
  'signed-out': 'Signed out',
  disabled: 'Sync is off',
}

export function lastSyncedText(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return 'Never synced'
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'Last synced just now'
  if (minutes < 60) return `Last synced ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `Last synced ${hours} h ago` : `Last synced ${new Date(at).toLocaleDateString()}`
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
function CloudIcon({ status }: { status: SyncState['status'] }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 15.5h8a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 4.7 9.6 3 3 0 0 0 6 15.5Z" />
      {status === 'idle-synced' && <path d="M7.5 11.5l1.8 1.8 3.4-3.6" />}
      {status === 'syncing' && (
        <g className="sync-arrows">
          <path d="M7.5 11a2.5 2.5 0 0 1 4.3-1.6M12.5 12a2.5 2.5 0 0 1-4.3 1.6" />
        </g>
      )}
      {status === 'offline' && <path d="M3 3l14 14" />}
      {status === 'error' && <path d="M10 9.5v2.5M10 14h.01" />}
    </svg>
  )
}

export function SyncStatus() {
  const state = useSyncState()
  const [open, setOpen] = useState(false)
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

  const status = state?.status ?? 'disabled'
  const label = LABELS[status]
  const last = lastSyncedText(state?.lastSyncedAt)
  return (
    <div className="sync-status-wrap" ref={ref}>
      <button
        type="button"
        className={`activity-button sync-status sync-${status}`}
        data-testid="sync-status"
        data-state={status}
        aria-label={`${label}. ${last}`}
        title={`${label}\n${last}`}
        onClick={() => setOpen((o) => !o)}
      >
        <CloudIcon status={status} />
      </button>
      {open && (
        <div className="sync-popover" data-testid="sync-popover" role="dialog" aria-label="Sync">
          <div className="sync-popover-status">{label}</div>
          {state?.status === 'error' && state.message && <div className="sync-popover-detail">{state.message}</div>}
          <div className="sync-popover-detail">{last}</div>
          {state?.account && <div className="sync-popover-detail">{state.account}</div>}
          <div className="sync-popover-actions">
            <button type="button" data-testid="sync-now" disabled={!state?.enabled} onClick={() => void window.slate.sync.now()}>
              Sync now
            </button>
            <button type="button" data-testid="sync-toggle" onClick={() => void window.slate.sync.setEnabled(!state?.enabled)}>
              {state?.enabled ? 'Turn off sync' : 'Turn on sync'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
