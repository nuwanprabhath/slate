import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncState, VaultStatus } from '../../../../shared/api'
import { errorText, openEncryptWizard } from '../../vault/events'
import { PasswordFields, type NewPasswordHandle } from '../../vault/PasswordFields'
import { SecretField } from '../../vault/SecretField'
import { sendSecrets, submitSecret, takeSecret } from '../../vault/secretInput'
import { zeroSecret } from '../../../../shared/secret'
import { allowedIdleOptions, profileLimits, shownIdleMinutes } from '../../../../shared/settings/schema'
import { CheckboxSetting } from '../fields/CheckboxSetting'
import { SelectSetting } from '../fields/SelectSetting'
import type { SectionProps } from '../registry'
import { CryptoModuleGroup } from './CryptoModuleGroup'
import { KeysGroup } from './KeysGroup'
import { securityRows } from './securitySlots'
import { settingsSandboxNotice } from './sandboxText'
import { securityStatusText } from './securityStatus'
import '../../lock/lock.css'
import '../../vault/vault.css'

const IDLE = [
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '240', label: '4 hours' },
  { value: '0', label: 'Never' },
] as const

export const securitySectionEntry = {
  id: 'security',
  label: 'Security',
  blurb: 'Encryption of your notes on this computer and in your sync folder, and when Slate locks.',
  keywords: ['fips', 'cmvp', 'cryptographic module', 'openssl', 'encrypt', 'encryption', 'password', 'recovery', 'key', 'lock', 'idle', 'sleep', 'touch id', 'keyring', 'vault'],
}

function ChangePassword() {
  const [useRecovery, setUseRecovery] = useState(false)
  const currentField = useRef<HTMLInputElement>(null)
  const [currentTyped, setCurrentTyped] = useState(false)
  const newPassword = useRef<NewPasswordHandle | null>(null)
  const [nextOk, setNextOk] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const onNextValid = useCallback((ok: boolean) => setNextOk(ok), [])
  const submit = async () => {
    const current = takeSecret(currentField.current)
    const next = newPassword.current?.take() ?? null
    setCurrentTyped(false)
    if (!current || !next) return zeroSecret(current, next)
    setBusy(true)
    try {
      const r = await sendSecrets([current, next], () => window.slate.vault.changePassword(useRecovery ? { recoveryKey: current } : { password: current }, next))
      setMessage(r.ok ? 'Password changed.' : r.message)
    } catch (e) {
      setMessage(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset className="settings-group" data-testid="security-change-password">
      <legend>Change password</legend>
      <label className="vault-field">
        <span>{useRecovery ? 'Recovery key' : 'Current password'}</span>
        <SecretField fieldRef={currentField} data-testid="security-current" onEdit={(f) => setCurrentTyped(f.value !== '')} />
      </label>
      <button type="button" className="lock-link settings-link" onClick={() => setUseRecovery(!useRecovery)}>
        {useRecovery ? 'Use the current password' : 'Forgot it? Use the recovery key'}
      </button>
      <PasswordFields control={newPassword} onValid={onNextValid} testId="security-new" />
      <div className="settings-actions">
        <button type="button" className="btn" data-testid="security-change-submit" disabled={busy || !nextOk || !currentTyped} onClick={() => void submit()}>
          Change password
        </button>
        <span className="vault-hint" data-testid="security-change-message">{message}</span>
      </div>
    </fieldset>
  )
}

function NewRecoveryKey() {
  const passwordField = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState(false)
  // The new key main made, shown once (the Z-11 residual of a new key).
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  const submit = async () => {
    const r = await submitSecret(passwordField.current, (pw) => window.slate.vault.newRecoveryKey(pw))
    setTyped(false)
    if (!r) return
    if (r.ok) {
      setKey(r.recoveryKey)
      setMessage('')
    } else setMessage(r.message)
  }
  return (
    <fieldset className="settings-group" data-testid="security-new-recovery">
      <legend>New recovery key</legend>
      <p className="settings-help">
        Changing your password or recovery key stops the old one opening this computer&apos;s vault. Anyone holding an older copy of the vault files
        (a backup, the sync repository&apos;s history, OneDrive versions) <em>and</em> the old password or key can still read the notes in that copy.
        Fully revoking an old secret would mean re-encrypting everything, which this version does not do.
      </p>
      {key ? (
        <>
          <div className="vault-key vault-print" data-testid="security-recovery-key">
            {key.split('-').map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
          <div className="security-row">
            <button type="button" onClick={() => void window.slate.vault.saveRecoveryKey(key).then((r) => setMessage(r.message ?? (r.saved ? 'Saved.' : '')))}>
              Save as text…
            </button>
            <button type="button" onClick={() => window.print()}>Print…</button>
            <button type="button" onClick={() => setKey('')}>Done</button>
          </div>
        </>
      ) : (
        <div className="security-row">
          <SecretField fieldRef={passwordField} data-testid="security-recovery-password" placeholder="Password" onEdit={(f) => setTyped(f.value !== '')} />
          <button type="button" disabled={!typed} onClick={() => void submit()}>
            Make a new recovery key
          </button>
        </div>
      )}
      <span className="vault-hint">{message}</span>
    </fieldset>
  )
}

/** §10. */
export function SecuritySection({ settings, patch, onClose }: SectionProps) {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [sync, setSync] = useState<SyncState | null>(null)
  useEffect(() => {
    void window.slate.vault.status().then(setStatus)
    void window.slate.sync
      .status()
      .then(setSync)
      .catch(() => setSync(null))
  }, [])
  if (!status) return null
  const encrypted = status.state === 'unlocked'
  const limits = profileLimits(status.profile)
  const sandboxNotice = settingsSandboxNotice(status, settings.sandboxNoticeDismissed)
  return (
    <>
      {sandboxNotice && (
        <div className="security-sandbox-notice" role="note" data-testid="security-sandbox-notice">
          <strong>{sandboxNotice.title}</strong>
          <p className="settings-help">{sandboxNotice.body}</p>
          <button type="button" data-testid="security-sandbox-dismiss" onClick={() => patch({ sandboxNoticeDismissed: true })}>
            Don't show again
          </button>
        </div>
      )}
      <p data-testid="security-status">{securityStatusText(status.state, sync)}</p>
      {status.profile && (
        <p data-testid="security-profile">
          Encryption profile: {status.profile === 'fips-140-3' ? 'FIPS 140-3 (U.S. federal)' : 'Standard'}. It is chosen when a vault is made and is never lowered.
        </p>
      )}
      {status.state === 'plaintext' && (
        <div className="security-row">
          <button
            type="button"
            data-testid="security-encrypt"
            onClick={() => {
              onClose()
              openEncryptWizard()
            }}
          >
            Encrypt my notes…
          </button>
        </div>
      )}
      {encrypted && (
        <>
          <ChangePassword />
          <NewRecoveryKey />
          <KeysGroup />
          <SelectSetting
            testId="security-idle"
            label="Lock after Slate is idle for"
            value={String(shownIdleMinutes(settings.idleMinutes, limits)) as (typeof IDLE)[number]['value']}
            options={allowedIdleOptions(IDLE, limits)}
            onChange={(v) => patch({ idleMinutes: Number(v) })}
          />
          <CheckboxSetting
            testId="security-lock-sleep"
            label="Lock when the computer sleeps"
            {...(limits.lockOnSleepForced ? { help: 'Always on for the FIPS 140-3 profile.' } : {})}
            checked={settings.lockOnSleep || limits.lockOnSleepForced}
            disabled={limits.lockOnSleepForced}
            onChange={(lockOnSleep) => patch({ lockOnSleep })}
          />
          <CheckboxSetting
            testId="security-lock-screen"
            label="Lock when the screen locks"
            help={limits.lockOnScreenLockForced ? 'Always on for the FIPS 140-3 profile.' : status.screenLockDetected ? undefined : 'Screen locking is not detected on this system.'}
            checked={settings.lockOnScreenLock || limits.lockOnScreenLockForced}
            disabled={limits.lockOnScreenLockForced}
            onChange={(lockOnScreenLock) => patch({ lockOnScreenLock })}
          />
          {securityRows().map((Row, i) => (
            <Row key={i} status={status} />
          ))}
          <div className="security-row">
            <button type="button" data-testid="security-lock-now" onClick={() => window.slate.vault.lock()}>
              Lock now
            </button>
          </div>
        </>
      )}
      <CryptoModuleGroup />
      <p className="settings-help">AI access works only while Slate is unlocked.</p>
    </>
  )
}
