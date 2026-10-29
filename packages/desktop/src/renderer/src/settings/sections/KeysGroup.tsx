import { useCallback, useEffect, useRef, useState } from 'react'
import type { RekeyKind, VaultKeysInfo } from '../../../../shared/api'
import { zeroSecret } from '../../../../shared/secret'
import { errorText } from '../../vault/events'
import { PasswordFields, type NewPasswordHandle } from '../../vault/PasswordFields'
import { SecretArea, SecretField } from '../../vault/SecretField'
import { sendSecrets, submitSecret, takeSecret } from '../../vault/secretInput'
import { keysInfoText, rekeyIntro, REKEY_TITLE } from './keysText'

type Step = 'password' | 'key' | 'running'

/** One key change (C9 R-1, R-3, R-5): the password(s), the new recovery key shown once and typed back, then the change. */
function RekeyFlow({ kind, onDone }: { kind: RekeyKind; onDone: (message: string) => void }) {
  const [step, setStep] = useState<Step>('password')
  const passwordField = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState(false)
  const newPassword = useRef<NewPasswordHandle | null>(null)
  const [nextOk, setNextOk] = useState(kind !== 'convert')
  const onNextValid = useCallback((ok: boolean) => setNextOk(ok), [])
  const confirmField = useRef<HTMLTextAreaElement>(null)
  const [confirmTyped, setConfirmTyped] = useState(false)
  // The new key main made, shown once (the Z-11 residual of a new key, as for "New recovery key").
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const prepare = async () => {
    const password = takeSecret(passwordField.current)
    const next = kind === 'convert' ? (newPassword.current?.take() ?? null) : null
    setTyped(false)
    if (!password || (kind === 'convert' && !next)) return zeroSecret(password, next)
    setBusy(true)
    try {
      const r = await sendSecrets([password, next], () => window.slate.vault.prepareRekey(kind, password, next ?? undefined))
      if (r.ok) {
        setKey(r.recoveryKey)
        setMessage('')
        setStep('key')
      } else setMessage(r.message)
    } catch (e) {
      setMessage(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const confirmAndRun = async () => {
    setBusy(true)
    try {
      const matched = await submitSecret(confirmField.current, (k) => window.slate.vault.confirmRecovery(k))
      setConfirmTyped(false)
      if (!matched) {
        setMessage('That is not the recovery key shown above. Check it and try again.')
        return
      }
      setStep('running')
      const r = await window.slate.vault.runRekey()
      onDone(r.ok ? 'Done. Your notes are encrypted under the new keys; your other devices follow when they next unlock.' : r.message)
    } catch (e) {
      onDone(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="security-rekey" data-testid={`security-rekey-${kind}`}>
      <p className="settings-help">{rekeyIntro(kind)}</p>
      {step === 'password' && (
        <>
          <SecretField fieldRef={passwordField} data-testid="security-rekey-password" placeholder="Current password" autoFocus onEdit={(f) => setTyped(f.value !== '')} />
          {kind === 'convert' && <PasswordFields control={newPassword} onValid={onNextValid} testId="security-rekey-new" profile="fips-140-3" />}
          <div className="security-row">
            <button type="button" onClick={() => onDone('')}>Cancel</button>
            <button type="button" className="vault-primary" data-testid="security-rekey-continue" disabled={busy || !typed || !nextOk} onClick={() => void prepare()}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </>
      )}
      {step === 'key' && (
        <>
          <p>Your new recovery key. The old one stops working. Save it now; it is shown only once.</p>
          <div className="vault-key vault-print" data-testid="security-rekey-recovery-key">
            {key.split('-').map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
          <div className="security-row">
            <button type="button" onClick={() => void window.slate.vault.saveRecoveryKey(key).then((r) => setMessage(r.message ?? (r.saved ? 'Saved.' : '')))}>
              Save as text…
            </button>
            <button type="button" onClick={() => window.print()}>Print…</button>
          </div>
          <p>Type the new recovery key to show it was saved:</p>
          <SecretArea fieldRef={confirmField} data-testid="security-rekey-confirm" onEdit={(f) => setConfirmTyped(f.value.trim() !== '')} />
          <div className="security-row">
            <button
              type="button"
              onClick={() => {
                void window.slate.vault.discardEncryption()
                onDone('')
              }}
            >
              Cancel
            </button>
            <button type="button" className="vault-primary" data-testid="security-rekey-run" disabled={busy || !confirmTyped} onClick={() => void confirmAndRun()}>
              {REKEY_TITLE[kind]}
            </button>
          </div>
        </>
      )}
      {step === 'running' && <p data-testid="security-rekey-running">Re-encrypting your notes under the new keys…</p>}
      <span className="vault-hint" data-testid="security-rekey-message">{message}</span>
    </div>
  )
}

/** C9: Settings → Security's key epoch, format and profile changes (audit §4.7; D-7 decides when they are offered). */
export function KeysGroup({ upgradeAsked = 0 }: { /** Bumped by "Upgrade encryption format…" elsewhere in Security. */ upgradeAsked?: number }) {
  const [info, setInfo] = useState<VaultKeysInfo | null>(null)
  const [open, setOpen] = useState<RekeyKind | null>(null)
  const group = useRef<HTMLFieldSetElement>(null)
  useEffect(() => {
    if (upgradeAsked === 0 || !info?.canUpgrade) return
    setOpen('upgrade')
    group.current?.scrollIntoView({ block: 'center' })
  }, [upgradeAsked, info?.canUpgrade])
  const [message, setMessage] = useState('')
  const refresh = useCallback(() => {
    void window.slate.vault
      .keysInfo()
      .then(setInfo)
      .catch((e: unknown) => setMessage(errorText(e)))
  }, [])
  useEffect(refresh, [refresh])
  if (!info) return null
  const text = keysInfoText(info)
  const replaceHistory = async () => {
    if (!window.confirm('Replace the sync repository’s history with one commit of its current files? Copies of the repository made before (other clones, backups) keep the old history.')) return
    const r = await window.slate.vault.replaceSyncHistory()
    setMessage(r.ok ? 'The sync history now holds only the current files.' : r.message)
    refresh()
  }
  return (
    <fieldset ref={group} className="settings-group" data-testid="security-keys">
      <legend>Encryption keys</legend>
      {text.lines.map((line, i) => (
        <p key={i} className="settings-help" data-testid={text.testIds[i]}>
          {line}
        </p>
      ))}
      {open ? (
        <RekeyFlow
          kind={open}
          onDone={(m) => {
            setOpen(null)
            setMessage(m)
            refresh()
          }}
        />
      ) : (
        <div className="security-row">
          {info.canRotate && (
            <button type="button" data-testid="security-rotate" onClick={() => setOpen('rotate')}>
              {REKEY_TITLE.rotate}…
            </button>
          )}
          {info.canUpgrade && (
            <button type="button" data-testid="security-upgrade" onClick={() => setOpen('upgrade')}>
              {REKEY_TITLE.upgrade}…
            </button>
          )}
          {info.canConvert && (
            <button type="button" data-testid="security-convert" onClick={() => setOpen('convert')}>
              {REKEY_TITLE.convert}…
            </button>
          )}
          {info.canReplaceHistory && (
            <button type="button" data-testid="security-replace-history" onClick={() => void replaceHistory()}>
              Replace sync history…
            </button>
          )}
        </div>
      )}
      <span className="vault-hint" data-testid="security-keys-message">{message}</span>
    </fieldset>
  )
}
