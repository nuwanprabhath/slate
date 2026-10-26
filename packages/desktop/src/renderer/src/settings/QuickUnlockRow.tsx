import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { QuickUnlockInfo } from '../../../shared/api'
import { SecretField } from '../vault/SecretField'
import { submitSecret } from '../vault/secretInput'
import { registerSecurityRow } from './sections/securitySlots'

/** §8, verbatim in spirit: what quick unlock does and does not protect against. */
export const QUICK_UNLOCK_NOTE =
  'Touch ID / keyring unlock is a convenience. Programs running as you can read this key without Touch ID; your password protects a stolen, powered-off computer.'

/**
 * Settings → Security: turn Touch ID (macOS) or keyring (Linux) unlock on or off. Self-contained,
 * so the Security section mounts it with no props. Turning it on asks for the password once.
 */
export function QuickUnlockRow() {
  const [info, setInfo] = useState<QuickUnlockInfo | null>(null)
  const [asking, setAsking] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.slate.vault
      .quickUnlockInfo()
      .then(setInfo)
      .catch(() => {})
  }, [])

  if (!info) return null
  const name = info.kind === 'keyring' ? 'Unlock with the system keyring' : 'Unlock with Touch ID'

  const enable = async (e: FormEvent) => {
    e.preventDefault()
    if (!typed || busy) return
    setBusy(true)
    setError(null)
    const result = (await submitSecret(field.current, (pw) => window.slate.vault.enableQuickUnlock(pw)).catch(() => null)) ?? {
      ok: false as const,
      message: 'Quick unlock could not be set up',
    }
    setBusy(false)
    setTyped(false)
    if (!result.ok) return setError(result.message)
    setAsking(false)
    setInfo({ ...info, enabled: true })
  }
  const disable = async () => {
    await window.slate.vault.disableQuickUnlock()
    setInfo({ ...info, enabled: false })
  }

  return (
    <div className="settings-field quick-unlock-row" data-testid="quick-unlock-row">
      <label>
        <input
          type="checkbox"
          data-testid="quick-unlock-toggle"
          checked={info.enabled || asking}
          disabled={!info.kind && !info.enabled}
          onChange={(e) => (e.target.checked ? setAsking(true) : info.enabled ? void disable() : setAsking(false))}
        />{' '}
        {name}
      </label>
      <p className="settings-hint">{info.kind ? QUICK_UNLOCK_NOTE : 'Not available on this computer (needs Touch ID, or a GNOME or KDE keyring).'}</p>
      {asking && !info.enabled && (
        <form onSubmit={(e) => void enable(e)}>
          <SecretField
            fieldRef={field}
            autoFocus
            data-testid="quick-unlock-password"
            placeholder="Your password"
            aria-label="Your password"
            onEdit={(f) => setTyped(f.value !== '')}
          />
          <button type="submit" disabled={!typed || busy}>
            Turn on
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      {info.enabled && (
        <button type="button" data-testid="quick-unlock-forget" onClick={() => void disable()}>
          Forget quick unlock
        </button>
      )}
    </div>
  )
}

// Settings → Security shows this row without importing it.
registerSecurityRow(QuickUnlockRow)
