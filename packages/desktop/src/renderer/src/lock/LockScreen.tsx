import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { QuickUnlockKind } from '../../../shared/api'
import { SecretField } from '../vault/SecretField'
import { submitSecret } from '../vault/secretInput'
import iconUrl from '../../../../resources/icon.png'
import './lock.css'

/** After this many failed passwords in a row the recovery key is suggested (§6.7). */
const SUGGEST_RECOVERY_AFTER = 5
const QUICK_FALLBACK = 'Touch ID unavailable — enter your password'

/**
 * Shown while an encrypted vault is locked. It calls only the vault channels the main process
 * allows before unlock. Once unlocked, main opens the app in a new window and destroys this one, so the
 * renderer process that saw the password exits (Z-6). The password is read from the field at submit and
 * never held in React state (Z-5).
 */
export function LockScreen() {
  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const field = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failures, setFailures] = useState(0)
  const [busy, setBusy] = useState(false)
  const [quick, setQuick] = useState<QuickUnlockKind | null>(null)

  useEffect(() => {
    void window.slate.vault
      .status()
      .then((s) => setQuick(s.quickUnlock ?? null))
      .catch(() => {})
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!typed || busy) return
    setBusy(true)
    setError(null)
    const vault = window.slate.vault
    const result = (await submitSecret(field.current, (s) => (mode === 'password' ? vault.unlock(s) : vault.unlockRecovery(s))).catch(() => null)) ?? {
      ok: false as const,
      message: "That password didn't work",
    }
    setTyped(false)
    setBusy(false)
    if (result.ok) return
    setError(mode === 'password' ? result.message : "That recovery key didn't work")
    setFailures(('failures' in result && result.failures) || failures + 1)
  }

  // Any failure, Touch ID cancelled included, leaves just the password field (§8).
  const quickUnlock = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await window.slate.vault.quickUnlock().catch(() => ({ ok: false as const, message: QUICK_FALLBACK }))
    setBusy(false)
    if (result.ok) return
    setQuick(null)
    setError(result.message)
  }

  const switchMode = () => {
    setMode(mode === 'password' ? 'recovery' : 'password')
    setTyped(false)
    setError(null)
  }

  return (
    <div className="lock-screen" data-testid="lock-screen">
      <form className="lock-card" onSubmit={(e) => void submit(e)}>
        <img className="lock-icon" src={iconUrl} alt="" width={64} height={64} />
        <h1 className="lock-title">Slate is locked</h1>
        <SecretField
          key={mode}
          fieldRef={field}
          autoFocus
          className="lock-field"
          data-testid="lock-secret"
          kind={mode === 'password' ? 'password' : 'text'}
          placeholder={mode === 'password' ? 'Password' : 'Recovery key'}
          aria-label={mode === 'password' ? 'Password' : 'Recovery key'}
          onEdit={(f) => setTyped(f.value !== '')}
        />
        <button type="submit" className="lock-unlock" data-testid="lock-unlock" disabled={!typed || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <p className="lock-error" data-testid="lock-error" role="alert">
          {error ?? ''}
        </p>
        {mode === 'password' && failures >= SUGGEST_RECOVERY_AFTER && <p className="lock-hint">Forgotten your password? Your recovery key opens Slate too.</p>}
        <button type="button" className="lock-link" data-testid="lock-switch" onClick={switchMode}>
          {mode === 'password' ? 'Use recovery key' : 'Use password'}
        </button>
        <div className="lock-quick" data-testid="lock-quick">
          {quick && mode === 'password' && (
            <button type="button" className="lock-unlock" data-testid="lock-quick-unlock" disabled={busy} onClick={() => void quickUnlock()}>
              {quick === 'touchid' ? 'Unlock with Touch ID' : 'Unlock'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
