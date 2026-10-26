import { useEffect, useRef, useState } from 'react'
import type { SyncState } from '../../../shared/api'
import { errorText, onOpenJoinDialog, openJoinDialog } from './events'
import { SecretArea, SecretField } from './SecretField'
import { submitSecret } from './secretInput'
import '../lock/lock.css'
import './vault.css'

/** §7.3: the remote's password (or recovery key) opens its vault on this device too. */
function JoinDialog({ problem, onClose }: { problem: SyncState['vaultProblem']; onClose: () => void }) {
  const [useRecovery, setUseRecovery] = useState(false)
  const passwordField = useRef<HTMLInputElement>(null)
  const recoveryField = useRef<HTMLTextAreaElement>(null)
  const [typed, setTyped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await submitSecret(useRecovery ? recoveryField.current : passwordField.current, (s) => window.slate.vault.join(useRecovery ? { recoveryKey: s } : { password: s }))
      setTyped(false)
      if (r && !r.ok) setError(r.message)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="vault-backdrop">
      <form
        className="vault-dialog"
        data-testid="vault-join-dialog"
        role="dialog"
        aria-label="Join encrypted notes"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2>Your notes are encrypted</h2>
        <p>
          {problem === 'other-vault'
            ? 'This sync folder is encrypted with a different password. Joining it switches this device to that password; your current recovery key and quick unlock stop applying here.'
            : problem === 'keys-changed'
              ? 'Your vault’s keys were changed on another device (a key rotation, a format upgrade or a conversion to FIPS 140-3). Enter its password, and this device re-encrypts its notes under the new keys and keeps syncing.'
              : 'Another device encrypted your synced notes. Enter the password you chose there, and this device encrypts its notes too and keeps syncing.'}
        </p>
        {useRecovery ? (
          <SecretArea fieldRef={recoveryField} data-testid="vault-join-recovery" placeholder="Recovery key" autoFocus onEdit={(f) => setTyped(f.value !== '')} />
        ) : (
          <SecretField fieldRef={passwordField} data-testid="vault-join-password" placeholder="Password" autoFocus onEdit={(f) => setTyped(f.value !== '')} />
        )}
        <button
          type="button"
          className="lock-link"
          data-testid="vault-join-use-recovery"
          onClick={() => {
            setUseRecovery(!useRecovery)
            setTyped(false)
          }}
        >
          {useRecovery ? 'Use the password' : 'Use the recovery key'}
        </button>
        <p className="vault-error" data-testid="vault-join-error">{error}</p>
        <div className="vault-actions">
          <button type="button" onClick={onClose}>Not now</button>
          <button type="submit" className="vault-primary" data-testid="vault-join-submit" disabled={busy || !typed}>
            {busy ? 'Encrypting…' : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Sync stopped at the vault check, or an older Slate writes plaintext: say so until it is dealt with. */
export function VaultBanners() {
  const [state, setState] = useState<SyncState | null>(null)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.slate.sync.status().then(setState)
    const offStatus = window.slate.sync.onStatus(setState)
    const offJoin = onOpenJoinDialog(() => setJoining(true))
    return () => {
      offStatus()
      offJoin()
    }
  }, [])

  const problem = state?.vaultProblem
  const encryptRemote = async () => {
    if (!window.confirm('Replace this sync folder with an encrypted copy of your notes? Its unencrypted history is removed from the branch.')) return
    const r = await window.slate.vault.encryptRemote()
    setError(r.ok ? '' : r.message)
  }
  return (
    <>
      {(problem === 'join-needed' || problem === 'other-vault' || problem === 'keys-changed') && (
        <div className="vault-banner" data-testid="vault-join-banner" role="status">
          <span className="vault-banner-text">
            {problem === 'join-needed'
              ? 'Your notes are now encrypted on another device. Enter your password to keep syncing.'
              : problem === 'keys-changed'
                ? 'Your vault’s keys were changed on another device. Enter its password to keep syncing.'
                : 'This sync folder is encrypted with a different password. Sync is paused.'}
          </span>
          <button type="button" data-testid="vault-join-open" onClick={openJoinDialog}>
            {problem === 'other-vault' ? 'Join it…' : 'Enter password…'}
          </button>
        </div>
      )}
      {problem === 'not-encrypted' && (
        <div className="vault-banner" data-testid="vault-remote-plain-banner" role="status">
          <span className="vault-banner-text">
            This sync folder is not encrypted, so Slate does not sync to it. {error && <span className="vault-error">{error}</span>}
          </span>
          <button type="button" data-testid="vault-encrypt-remote" onClick={() => void encryptRemote()}>
            Encrypt this sync folder (replaces its history)
          </button>
        </div>
      )}
      {state?.plaintextWarning && (
        <div className="vault-banner" data-testid="vault-plaintext-warning" role="alert">
          <span className="vault-banner-text">A device running an older Slate is writing unencrypted notes to your sync folder — update it.</span>
        </div>
      )}
      {joining && <JoinDialog problem={problem} onClose={() => setJoining(false)} />}
    </>
  )
}
