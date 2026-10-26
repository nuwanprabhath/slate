import { useEffect, useRef, useState } from 'react'
import { errorText } from '../vault/events'
import { SecretField } from '../vault/SecretField'
import { submitSecret } from '../vault/secretInput'
import './lock.css'

/** §15 N10: encryption was started but never finished; the notes are still the plaintext ones. */
export function MigrationBanner() {
  const [show, setShow] = useState(false)
  const [asking, setAsking] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.slate.vault.status().then((s) => setShow(s.state === 'migrating'))
  }, [])

  if (!show) return null
  const vault = window.slate.vault
  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      // Success reloads the window into the encrypted notes.
      const r = await submitSecret(field.current, (pw) => vault.finishMigration(pw))
      setTyped(false)
      if (r && !r.ok) setError(r.message)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="migration-banner" data-testid="migration-banner" role="status">
      <span className="migration-banner-text">
        Encrypting your notes did not finish. {error && <span className="migration-banner-error">{error}</span>}
      </span>
      {asking ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void finish()
          }}
        >
          <SecretField fieldRef={field} data-testid="migration-password" placeholder="Your new password" autoFocus onEdit={(f) => setTyped(f.value !== '')} />
          <button type="submit" data-testid="migration-finish-submit" disabled={busy || !typed}>
            {busy ? 'Encrypting…' : 'Finish'}
          </button>
        </form>
      ) : (
        <button type="button" data-testid="migration-finish" onClick={() => setAsking(true)}>
          Finish encrypting your notes
        </button>
      )}
      <button type="button" data-testid="migration-cancel" disabled={busy} onClick={() => void vault.cancelMigration().then(() => setShow(false))}>
        Cancel encryption
      </button>
    </div>
  )
}
