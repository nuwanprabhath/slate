import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { allSavesIdle } from '@slate/editor'
import type { PrivacyStatus, VaultState } from '../../../../shared/api'
import { CONSENT_FEATURES, DISCLOSURES, type ConsentFeature } from '../../../../shared/privacy/consent'
import { currentSession, pageReload } from '../../currentSession'
import { errorText } from '../../vault/events'
import { CheckboxSetting } from '../fields/CheckboxSetting'
import type { SectionProps } from '../registry'
import '../../vault/vault.css'
import './privacySection.css'

/** For the Settings registry. No word here may contain "git": the settings search for it must find Sync alone. */
export const privacySectionEntry = {
  id: 'privacy',
  label: 'Privacy',
  blurb: 'What may leave this computer, and your own copy or erasure of everything Slate keeps.',
  keywords: ['privacy', 'gdpr', 'export', 'erase', 'delete', 'consent', 'data', 'withdraw', 'security log', 'portability'],
}

/** The security log can grow to 2 MB; the view shows the most recent part. */
const LOG_VIEW_CHARS = 200 * 1024

const dateText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** An inline confirmation in place of `window.confirm`: the question, then the action and a way back. */
function Confirm({ testId, children, confirmLabel, onConfirm, onCancel, disabled }: {
  testId: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  disabled?: boolean
}) {
  return (
    <div className="privacy-confirm" role="group" aria-label={confirmLabel} data-testid={testId}>
      {children}
      <div className="settings-actions">
        <button type="button" className="btn danger" data-testid={`${testId}-yes`} disabled={disabled} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="btn" data-testid={`${testId}-no`} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function StrictMode({ on, patch }: { on: boolean; patch: SectionProps['patch'] }) {
  const [asking, setAsking] = useState(false)
  return (
    <fieldset className="settings-group" data-testid="privacy-strict-group">
      <legend>Strict privacy mode</legend>
      <CheckboxSetting
        testId="privacy-strict"
        label="Ask before anything leaves this computer"
        help="On, no feature contacts another computer until you allow it here or when you first use it. Off, every feature you set up runs without asking."
        checked={on && !asking}
        onChange={(checked) => (checked ? (setAsking(false), patch({ gdprStrictMode: true })) : setAsking(true))}
      />
      {asking && (
        <Confirm testId="privacy-strict-off" confirmLabel="Turn strict mode off" onConfirm={() => (setAsking(false), patch({ gdprStrictMode: false }))} onCancel={() => setAsking(false)}>
          <p>With strict mode off, each of these runs as soon as it is set up, without asking first:</p>
          <ul className="privacy-disclosures" data-testid="privacy-strict-off-list">
            {CONSENT_FEATURES.map((f) => (
              <li key={f}>
                <strong>{DISCLOSURES[f].title}</strong>
                <span className="settings-help">
                  {DISCLOSURES[f].recipient}
                  {DISCLOSURES[f].endpoints.length > 0 ? ` (${DISCLOSURES[f].endpoints.join(', ')})` : ''}: {DISCLOSURES[f].data.join('; ')}
                </span>
              </li>
            ))}
          </ul>
        </Confirm>
      )}
    </fieldset>
  )
}

function Consents({ status, onRevoke }: { status: PrivacyStatus | null; onRevoke: (f: ConsentFeature) => void }) {
  const granted = CONSENT_FEATURES.filter((f) => status?.consents[f])
  return (
    <fieldset className="settings-group" data-testid="privacy-consents">
      <legend>What you have allowed</legend>
      {granted.length === 0 ? (
        <p className="settings-help" data-testid="privacy-consents-empty">
          Nothing yet. Slate asks the first time a feature would contact another computer.
        </p>
      ) : (
        <ul className="privacy-consent-list">
          {granted.map((f) => {
            const record = status!.consents[f]!
            return (
              <li key={f} className="privacy-consent" data-testid={`privacy-consent-${f}`}>
                <span className="privacy-consent-text">
                  <strong>{DISCLOSURES[f].title}</strong>
                  <span className="settings-help">
                    {record.source === 'legacy' ? 'Kept from before strict mode; it was already set up.' : `Allowed ${dateText(record.grantedAt)}.`} Sends to {DISCLOSURES[f].recipient}.
                  </span>
                </span>
                <button type="button" className="btn" data-testid={`privacy-withdraw-${f}`} onClick={() => onRevoke(f)}>
                  Withdraw
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </fieldset>
  )
}

function YourData() {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmPurge, setConfirmPurge] = useState(false)
  const exportAll = () => {
    setBusy(true)
    setNote('Exporting…')
    window.slate.privacy
      .exportAll()
      .then((r) => setNote(r ? `Exported ${String(r.pages)} pages and ${String(r.images)} images to ${r.folder}` : ''))
      .catch((e: unknown) => setNote(`Could not export: ${errorText(e)}`))
      .finally(() => setBusy(false))
  }
  const purge = () => {
    setConfirmPurge(false)
    setBusy(true)
    window.slate.privacy
      .purge('all')
      .then((r) => setNote(`Purged: ${String(r.blobs)} unused images, ${String(r.tempDirs)} temporary folders, the diagnostic log and the AI activity record.${r.securityLogKept ? ` ${r.securityLogKept}` : ''}`))
      .catch((e: unknown) => setNote(`Could not purge: ${errorText(e)}`))
      .finally(() => setBusy(false))
  }
  return (
    <fieldset className="settings-group" data-testid="privacy-data">
      <legend>Your data</legend>
      <p className="settings-help">
        An export is a new folder with every page as Markdown (private boxes too), every image, your settings, the AI activity record, the sync conflicts and the security log. Nothing in
        it is encrypted, so keep it somewhere safe.
      </p>
      {confirmPurge ? (
        <Confirm testId="privacy-purge-confirm" confirmLabel="Purge" onConfirm={purge} onCancel={() => setConfirmPurge(false)}>
          <p>Remove the diagnostic log, the AI activity record, unused images, the search index (it is rebuilt) and temporary files, then compact the database?</p>
        </Confirm>
      ) : (
        <div className="settings-actions">
          <button type="button" className="btn" data-testid="privacy-export" disabled={busy} onClick={exportAll}>
            Export everything…
          </button>
          <button type="button" className="btn" data-testid="privacy-purge" disabled={busy} onClick={() => setConfirmPurge(true)}>
            Purge caches and logs…
          </button>
        </div>
      )}
      <span className="vault-hint privacy-note" role="status" data-testid="privacy-data-note">
        {note}
      </span>
    </fieldset>
  )
}

function SecurityLog({ profile }: { profile: PrivacyStatus['profile'] | undefined }) {
  const [text, setText] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const fips = profile === 'fips-140-3'
  const view = () => {
    window.slate.privacy
      .readSecurityLog()
      .then((t) => {
        setText(t.length > LOG_VIEW_CHARS ? t.slice(-LOG_VIEW_CHARS) : t)
        setNote(t.length > LOG_VIEW_CHARS ? 'Showing the most recent 200 KB.' : t === '' ? 'The security log is empty.' : '')
      })
      .catch((e: unknown) => setNote(`Could not read the security log: ${errorText(e)}`))
  }
  const clear = () => {
    setConfirming(false)
    window.slate.privacy
      .clearSecurityLog()
      .then(() => {
        setText(null)
        setNote('Cleared.')
      })
      .catch((e: unknown) => setNote(`Could not clear the security log: ${errorText(e)}`))
  }
  return (
    <fieldset className="settings-group" data-testid="privacy-security-log">
      <legend>Security log</legend>
      <p className="settings-help">When Slate was unlocked and locked, and how; which windows were refused; the self-test results. No notes, titles or search words.</p>
      {confirming ? (
        <Confirm testId="privacy-log-clear-confirm" confirmLabel="Clear security log" onConfirm={clear} onCancel={() => setConfirming(false)}>
          <p>Delete the security log? You cannot get it back.</p>
        </Confirm>
      ) : (
        <div className="settings-actions">
          <button type="button" className="btn" data-testid="privacy-log-view" onClick={view}>
            {text === null ? 'View security log' : 'Refresh'}
          </button>
          <button type="button" className="btn danger" data-testid="privacy-log-clear" disabled={fips} onClick={() => setConfirming(true)}>
            Clear security log…
          </button>
        </div>
      )}
      {fips && (
        <p className="settings-help" data-testid="privacy-log-fips">
          A FIPS 140-3 vault keeps its security log for 90 days (AU-2), so it cannot be cleared here.
        </p>
      )}
      {text !== null && text !== '' && (
        <textarea className="privacy-log" data-testid="privacy-log-text" aria-label="Security log" readOnly rows={12} spellCheck={false} wrap="soft" value={text} />
      )}
      <span className="vault-hint privacy-note" role="status" data-testid="privacy-log-note">
        {note}
      </span>
    </fieldset>
  )
}

type EraseRow = 'history' | 'remote' | 'all'

function EraseNote({ testId, text }: { testId: string; text: string }) {
  return (
    <span className="vault-hint privacy-note" role="status" data-testid={testId}>
      {text}
    </span>
  )
}

type RemoteHistory = { kind: 'none' } | { kind: 'encrypted'; remote: string } | { kind: 'plaintext'; remote: string }

function Erase({ settings }: { settings: SectionProps['settings'] }) {
  const syncOn = settings.syncProvider !== null
  const pageId = currentSession.get()?.pageId ?? null
  const [ask, setAsk] = useState<'history' | 'remote' | 'all' | null>(null)
  const [typed, setTyped] = useState('')
  // Each result is shown under the action it came from, not at the foot of the group.
  const [note, setNote] = useState<{ row: EraseRow; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [remote, setRemote] = useState<RemoteHistory>({ kind: 'none' })
  useEffect(() => {
    if (settings.syncProvider !== 'git') return setRemote({ kind: 'none' })
    const url = settings.git?.remoteUrl ?? ''
    let live = true
    window.slate.vault
      .status()
      .then(async (s: { state: VaultState }) => {
        if (s.state === 'plaintext') return { kind: 'plaintext', remote: url } as const
        const info = await window.slate.vault.keysInfo()
        return info.canReplaceHistory ? ({ kind: 'encrypted', remote: url } as const) : ({ kind: 'none' } as const)
      })
      .then((r) => live && setRemote(r))
      .catch(() => live && setRemote({ kind: 'none' }))
    return () => {
      live = false
    }
  }, [settings.syncProvider, settings.git?.remoteUrl])

  const run = (row: EraseRow, work: () => Promise<string>) => {
    setAsk(null)
    setBusy(true)
    work()
      .then((text) => setNote({ row, text }))
      .catch((e: unknown) => setNote({ row, text: errorText(e) }))
      .finally(() => setBusy(false))
  }
  const eraseHistory = () =>
    run('history', async () => {
      if (!pageId) return ''
      // Every edit stored first: one still queued would be written after the erase, on top of the history it removed.
      await allSavesIdle()
      await window.slate.privacy.eraseHistory(`page:${pageId}`)
      // The open editor still holds the erased text, and its undo stack could bring it back.
      pageReload.request(pageId)
      return 'The open page’s edit history is erased; it keeps only what it shows now.'
    })
  const replaceRemote = () =>
    run('remote', async () => {
      const r = await window.slate.vault.replaceSyncHistory()
      return r.ok ? 'The sync repository’s history now holds only the current, encrypted files.' : r.message
    })
  const eraseAll = () => {
    setBusy(true)
    setNote({ row: 'all', text: 'Erasing everything; Slate will restart…' })
    setAsk(null)
    window.slate.privacy.eraseAll('ERASE').then(
      (erased) => {
        if (erased) return
        // Cancelled at main's own question: nothing was touched.
        setBusy(false)
        setTyped('')
        setNote({ row: 'all', text: 'Nothing was erased.' })
      },
      (e: unknown) => {
        setBusy(false)
        setNote({ row: 'all', text: `Could not erase: ${errorText(e)}` })
      },
    )
  }

  // Main says up front what it would refuse (a page synced before, a build that cannot), so the button is never offered
  // only to be refused; asked again after each erase result.
  const [mainReason, setMainReason] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setMainReason(null)
    if (syncOn || !pageId) return
    window.slate.privacy.historyEraseBlocker(`page:${pageId}`).then(
      (reason) => live && setMainReason(reason),
      () => {},
    )
    return () => {
      live = false
    }
  }, [syncOn, pageId, note])
  const historyReason = syncOn ? 'Turn sync off first: other devices keep their own copies and would bring the history back.' : !pageId ? 'Open a page first.' : (mainReason ?? '')
  return (
    <fieldset className="settings-group" data-testid="privacy-erase">
      <legend>Erase</legend>
      {ask === 'history' ? (
        <Confirm testId="privacy-history-confirm" confirmLabel="Erase edit history" onConfirm={eraseHistory} onCancel={() => setAsk(null)}>
          <p>Keep only what the open page shows now, and remove every earlier version of it, including text you deleted, from this computer?</p>
        </Confirm>
      ) : ask === 'remote' && remote.kind === 'encrypted' ? (
        <Confirm testId="privacy-remote-confirm" confirmLabel="Replace remote history" onConfirm={replaceRemote} onCancel={() => setAsk(null)}>
          <p>
            Replace the history of <code className="settings-path">{remote.remote}</code> with one commit of its current files? Clones and backups made before keep
            the old history.
          </p>
        </Confirm>
      ) : ask === 'all' ? (
        <Confirm testId="privacy-all-confirm" confirmLabel="Erase all Slate data" disabled={typed !== 'ERASE' || busy} onConfirm={eraseAll} onCancel={() => (setAsk(null), setTyped(''))}>
          <p>
            This deletes every notebook, image, setting, log, sync connection and saved sign-in on this computer, then restarts Slate empty. There is no undo; export
            first if you want a copy.
          </p>
          {syncOn && (
            <p className="privacy-warning" data-testid="privacy-all-remote">
              Your sync {settings.syncProvider === 'git' ? 'repository' : 'folder'} and your other devices keep their copies. Erase those there
              {remote.kind === 'encrypted' ? ', or replace the remote history first' : ''}.
            </p>
          )}
          <label className="vault-field">
            <span>Type ERASE to confirm</span>
            <input type="text" data-testid="privacy-all-typed" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        </Confirm>
      ) : (
        <>
          <div className="privacy-erase-row">
            <button type="button" className="btn" data-testid="privacy-erase-history" disabled={busy || historyReason !== ''} onClick={() => setAsk('history')}>
              Erase edit history of this page…
            </button>
            <span className="settings-help">{historyReason || 'Removes earlier versions and deleted text; the page keeps what it shows now. Only for a page that has never been synced.'}</span>
            <EraseNote testId="privacy-erase-note" text={note?.row === 'history' ? note.text : ''} />
          </div>
          {remote.kind !== 'none' && (
            <div className="privacy-erase-row">
              <button type="button" className="btn" data-testid="privacy-replace-remote" disabled={busy || remote.kind === 'plaintext'} onClick={() => setAsk('remote')}>
                Replace remote history…
              </button>
              <span className="settings-help" data-testid="privacy-replace-remote-help">
                {remote.kind === 'plaintext' ? 'For an unencrypted repository, this is coming in the next release.' : 'The repository keeps only one commit of its current files.'}
              </span>
              <EraseNote testId="privacy-remote-note" text={note?.row === 'remote' ? note.text : ''} />
            </div>
          )}
          <div className="privacy-erase-row">
            <button type="button" className="btn danger" data-testid="privacy-erase-all" disabled={busy} onClick={() => setAsk('all')}>
              Erase all Slate data…
            </button>
            <span className="settings-help">Everything Slate keeps on this computer, then a restart.</span>
            <EraseNote testId="privacy-all-note" text={note?.row === 'all' ? note.text : ''} />
          </div>
        </>
      )}
    </fieldset>
  )
}

/** Settings → Privacy (GDPR review §3.5 step 6). */
export function PrivacySection({ settings, patch }: SectionProps) {
  const [status, setStatus] = useState<PrivacyStatus | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(() => {
    window.slate.privacy
      .status()
      .then(setStatus)
      .catch((e: unknown) => setError(errorText(e)))
  }, [])
  useEffect(refresh, [refresh, settings.gdprStrictMode, settings.consents])
  const revoke = (f: ConsentFeature) => {
    window.slate.privacy
      .revoke(f)
      .then(setStatus)
      .catch((e: unknown) => setError(errorText(e)))
  }
  return (
    <div className="settings-stack privacy-section" data-testid="privacy-section">
      <StrictMode on={settings.gdprStrictMode} patch={patch} />
      <Consents status={status} onRevoke={revoke} />
      <YourData />
      <SecurityLog profile={status?.profile} />
      <Erase settings={settings} />
      <span className="vault-hint privacy-note" role="status" data-testid="privacy-error">
        {error}
      </span>
    </div>
  )
}
