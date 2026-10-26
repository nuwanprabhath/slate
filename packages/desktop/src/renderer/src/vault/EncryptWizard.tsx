import { useCallback, useEffect, useRef, useState } from 'react'
import type { EncryptProgress, VaultProfile } from '../../../shared/api'
import { errorText, onOpenEncryptWizard, openJoinDialog } from './events'
import { PasswordFields, type NewPasswordHandle } from './PasswordFields'
import { SecretArea } from './SecretField'
import { sendSecrets, submitSecret } from './secretInput'
import './vault.css'

type Step = 'explain' | 'devices' | 'password' | 'recovery' | 'confirm' | 'wipe' | 'progress'

const PHASES: Array<{ phase: EncryptProgress['phase']; label: string; sync?: boolean }> = [
  { phase: 'remote', label: 'Syncing once more', sync: true },
  { phase: 'claim', label: 'Replacing the sync folder with an encrypted one', sync: true },
  { phase: 'close', label: 'Closing your notes' },
  { phase: 'copy', label: 'Encrypting your notes and images' },
  { phase: 'bookkeeping', label: 'Preparing a full encrypted sync' },
  { phase: 'switch', label: 'Switching to the encrypted notes' },
  { phase: 'cleanup', label: 'Removing the unencrypted copies' },
  { phase: 'open', label: 'Opening your encrypted notes' },
]

/** §7.1: "Encrypt my notes". Main holds the keys; this page only ever sees the recovery key to show. */
export function EncryptWizard() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('explain')
  const [syncOn, setSyncOn] = useState(false)
  const newPassword = useRef<NewPasswordHandle | null>(null)
  const [passwordOk, setPasswordOk] = useState(false)
  // The recovery key main made, shown once: on screen by design (the Z-11 residual of a new key).
  const [recoveryKey, setRecoveryKey] = useState('')
  const confirmField = useRef<HTMLTextAreaElement>(null)
  const [confirmTyped, setConfirmTyped] = useState(false)
  const [wipeOk, setWipeOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<EncryptProgress['phase'] | null>(null)
  // The FIPS 140-3 choice exists only where the approved module runs (docs/compliance/decisions.md).
  const [fipsAvailable, setFipsAvailable] = useState(false)
  const [profile, setProfile] = useState<VaultProfile>('standard')

  const reset = () => {
    setStep('explain')
    setPasswordOk(false)
    setRecoveryKey('')
    setConfirmTyped(false)
    setWipeOk(false)
    setError('')
    setNote('')
    setPhase(null)
    setProfile('standard')
  }
  useEffect(
    () =>
      onOpenEncryptWizard(() => {
        reset()
        void window.slate.sync.status().then((s) => setSyncOn(s.enabled))
        void window.slate.vault.moduleStatus().then((m) => setFipsAvailable(m.approvedMode))
        setOpen(true)
      }),
    [],
  )
  useEffect(() => window.slate.vault.onProgress((p) => setPhase(p.phase)), [])
  const onPasswordValid = useCallback((ok: boolean) => setPasswordOk(ok), [])

  if (!open) return null
  const close = () => {
    if (step === 'progress') return
    void window.slate.vault.discardEncryption()
    setOpen(false)
  }
  const guard = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const toJoin = () => {
    setOpen(false)
    openJoinDialog()
  }
  const prepare = () =>
    guard(async () => {
      const pw = newPassword.current?.take()
      if (!pw) return
      const r = await sendSecrets([pw], () => window.slate.vault.prepareEncryption(pw, fipsAvailable ? profile : 'standard'))
      if (r.kind === 'join') return toJoin()
      setRecoveryKey(r.recoveryKey)
      setStep('recovery')
    })
  const confirm = () =>
    guard(async () => {
      const matched = await submitSecret(confirmField.current, (key) => window.slate.vault.confirmRecovery(key))
      setConfirmTyped(false)
      if (!matched) throw new Error('That is not the recovery key shown before. Check it and try again.')
      setStep(syncOn ? 'wipe' : 'progress')
      if (!syncOn) await run()
    })
  const run = async () => {
    setStep('progress')
    try {
      const r = await window.slate.vault.encrypt()
      // Done: main reloads the window into the encrypted notes.
      if (r.kind === 'join') toJoin()
    } catch (e) {
      setError(errorText(e))
    }
  }
  const copy = async () => {
    await navigator.clipboard.writeText(recoveryKey)
    window.slate.vault.copied()
    setNote('Copied. Paste it somewhere safe that is not on this computer.')
  }
  const save = () =>
    guard(async () => {
      const r = await window.slate.vault.saveRecoveryKey(recoveryKey)
      if (r.message) throw new Error(r.message)
      if (r.saved) setNote('Saved.')
    })

  const groups = recoveryKey.split('-')
  const next = (to: Step) => () => setStep(to)
  return (
    <div className="vault-backdrop">
      <section className="vault-dialog" data-testid="encrypt-wizard" role="dialog" aria-label="Encrypt my notes">
        {step === 'explain' && (
          <>
            <h2>Encrypt my notes</h2>
            <p>
              Slate will encrypt every note and image on this computer{syncOn ? ' and in your sync folder' : ''}. Only your password or your recovery key
              can open them.
            </p>
            <p>
              <strong>If you forget your password and lose your recovery key, your notes are gone</strong> — synced copies included. Nobody can recover
              them, not even Slate's author.
            </p>
            <p>
              Copies made before today stay readable: Time Machine or other backups, disk snapshots, and old sync history kept elsewhere. Turn on
              FileVault (macOS) or LUKS (Linux) to protect the whole disk, and prune old backups if they matter.
            </p>
            <p className="vault-hint">Encryption cannot be turned off again in this version.</p>
            <div className="vault-actions">
              <button type="button" onClick={close}>Cancel</button>
              <button type="button" className="vault-primary" data-testid="wizard-next" onClick={next(syncOn ? 'devices' : 'password')}>
                Continue
              </button>
            </div>
          </>
        )}
        {step === 'devices' && (
          <>
            <h2>Update your other devices first</h2>
            <p>
              Every other computer that syncs these notes must run this version of Slate before you continue. An older Slate cannot read encrypted notes,
              and would keep writing unencrypted copies into your sync folder.
            </p>
            <div className="vault-actions">
              <button type="button" onClick={close}>Cancel</button>
              <button type="button" className="vault-primary" data-testid="wizard-next" onClick={next('password')}>
                They are up to date
              </button>
            </div>
          </>
        )}
        {step === 'password' && (
          <>
            <h2>Choose a password</h2>
            <p>You will type it every time Slate starts and after it locks.</p>
            {fipsAvailable && (
              <fieldset className="vault-profile" data-testid="wizard-profile">
                <legend>Encryption profile (cannot be lowered later)</legend>
                <label>
                  <input type="radio" name="vault-profile" data-testid="wizard-profile-standard" checked={profile === 'standard'} onChange={() => setProfile('standard')} />
                  Standard
                </label>
                <label>
                  <input type="radio" name="vault-profile" data-testid="wizard-profile-fips" checked={profile === 'fips-140-3'} onChange={() => setProfile('fips-140-3')} />
                  FIPS 140-3 (U.S. federal)
                </label>
                {profile === 'fips-140-3' && (
                  <p className="vault-hint">
                    NIST-approved algorithms only, in the validated module. Passwords need 15 characters, and Touch ID or keyring unlock is not offered.
                  </p>
                )}
              </fieldset>
            )}
            <PasswordFields control={newPassword} onValid={onPasswordValid} profile={profile} />
            <p className="vault-error" data-testid="wizard-error">{error}</p>
            <div className="vault-actions">
              <button type="button" onClick={close}>Cancel</button>
              <button type="button" className="vault-primary" data-testid="wizard-next" disabled={!passwordOk || busy} onClick={() => void prepare()}>
                {busy ? 'Preparing…' : 'Continue'}
              </button>
            </div>
          </>
        )}
        {step === 'recovery' && (
          <>
            <h2>Your recovery key</h2>
            <p>If you forget your password, this key opens your notes. Keep it somewhere safe, away from this computer. It is shown only now.</p>
            <div className="vault-key vault-print" data-testid="recovery-key">
              {groups.map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </div>
            <div className="security-row">
              <button type="button" data-testid="recovery-copy" onClick={() => void copy()}>Copy</button>
              <button type="button" data-testid="recovery-save" onClick={() => void save()}>Save as text…</button>
              <button type="button" data-testid="recovery-print" onClick={() => window.print()}>Print…</button>
            </div>
            <p className="vault-hint">
              Documents may sync to iCloud or another cloud drive; printing the key or keeping it in a password manager is safer than a text file there.
            </p>
            <p className="vault-hint">{note}</p>
            <p className="vault-error">{error}</p>
            <div className="vault-actions">
              <button type="button" onClick={close}>Cancel</button>
              <button type="button" className="vault-primary" data-testid="wizard-next" onClick={next('confirm')}>
                I have saved it
              </button>
            </div>
          </>
        )}
        {step === 'confirm' && (
          <>
            <h2>Enter your recovery key</h2>
            <p>Type or paste the whole key, to show it was saved correctly.</p>
            <SecretArea fieldRef={confirmField} data-testid="recovery-confirm-input" autoFocus onEdit={(f) => setConfirmTyped(f.value.trim() !== '')} />
            <p className="vault-error" data-testid="wizard-error">{error}</p>
            <div className="vault-actions">
              <button type="button" onClick={next('recovery')}>Back</button>
              <button type="button" className="vault-primary" data-testid="wizard-next" disabled={!confirmTyped || busy} onClick={() => void confirm()}>
                Continue
              </button>
            </div>
          </>
        )}
        {step === 'wipe' && (
          <>
            <h2>Replace your sync folder's history</h2>
            <p>
              Your sync folder will be replaced by one encrypted copy. Its unencrypted history is removed from the branch Slate syncs to. Copies kept
              elsewhere (forks, other clones, OneDrive's recycle bin and version history) are not touched: delete them yourself if they matter.
            </p>
            <p data-testid="wipe-orphan-note">
              Hosts such as GitHub keep the old commits reachable by their ID until their own clean-up runs, which can take a long time. For a full
              guarantee, sync to a new repository and delete the old one.
            </p>
            <label className="security-row">
              <input type="checkbox" data-testid="wipe-confirm" checked={wipeOk} onChange={(e) => setWipeOk(e.target.checked)} />
              Replace the history of my sync folder
            </label>
            <div className="vault-actions">
              <button type="button" onClick={close}>Cancel</button>
              <button type="button" className="vault-primary" data-testid="wizard-next" disabled={!wipeOk} onClick={() => void run()}>
                Encrypt my notes
              </button>
            </div>
          </>
        )}
        {step === 'progress' && (
          <>
            <h2>Encrypting your notes</h2>
            <p>Keep Slate open. Your notes are back in a moment.</p>
            <ul className="vault-steps" data-testid="wizard-progress">
              {PHASES.filter((p) => syncOn || !p.sync).map((p, i, all) => {
                const at = phase === null ? -1 : all.findIndex((x) => x.phase === phase)
                return (
                  <li key={p.phase} data-state={i < at ? 'done' : i === at ? 'active' : 'todo'}>
                    {p.label}
                  </li>
                )
              })}
            </ul>
            <p className="vault-error" data-testid="wizard-error">{error}</p>
            {error && (
              <div className="vault-actions">
                <button type="button" onClick={() => setOpen(false)}>Close</button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
