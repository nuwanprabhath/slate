import { useEffect, useRef, useState } from 'react'
import { errorText } from '../vault/events'
import { SecretField } from '../vault/SecretField'
import { submitSecret } from '../vault/secretInput'
import { FORMAT_DONE, FORMAT_RUNNING, nextFormatBanner, type FormatMemory } from './vaultFormatBanner'
import './lock.css'

/** The banners above the notes about the vault: an unfinished encryption (N10) and the vault format update (PQ-D2). */
export function MigrationBanner() {
  return (
    <>
      <UnfinishedEncryption />
      <VaultFormatBanner />
    </>
  )
}

const MEMORY_KEY = 'slate.vaultFormatSawV2'
/** Quick while the format is updating, slow otherwise: the update starts at most once per unlock or sync. */
const POLL_RUNNING_MS = 2000
const POLL_IDLE_MS = 5_000

/**
 * The remembered "a version 2 vault was seen" is a per-computer convenience: renderer storage lives in this data
 * folder, which holds one vault, so it is per vault. Losing it only means the "updated" line is not shown.
 */
function readMemory(): FormatMemory {
  try {
    return { sawV2: localStorage.getItem(MEMORY_KEY) === '1' }
  } catch {
    return { sawV2: false }
  }
}
function writeMemory(m: FormatMemory): void {
  try {
    if (m.sawV2) localStorage.setItem(MEMORY_KEY, '1')
    else localStorage.removeItem(MEMORY_KEY)
  } catch {
    // Storage can be unavailable; the line is a courtesy.
  }
}

/**
 * A line, not a prompt: it takes no focus and no space beyond its own row (the shell keeps the notes below it).
 * "Updated" is shown once, then forgotten.
 */
function VaultFormatBanner() {
  const [show, setShow] = useState<'running' | 'done' | null>(null)

  useEffect(() => {
    let alive = true
    let memory = readMemory()
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    const poll = async () => {
      try {
        const { vault } = await window.slate.vault.pqReadiness()
        if (!alive) return
        running = vault.kind === 'header' && vault.upgrade === 'running'
        const step = nextFormatBanner(memory, vault)
        if (step.next.sawV2 !== memory.sawV2) writeMemory(step.next)
        memory = step.next
        // A shown "updated" stays until dismissed; later polls say nothing and must not hide it.
        setShow((prev) => (prev === 'done' && step.show === null ? prev : step.show))
      } catch {
        // Locked, or main is busy: ask again.
      }
      if (alive) timer = setTimeout(() => void poll(), running ? POLL_RUNNING_MS : POLL_IDLE_MS)
    }
    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  if (show === null) return null
  return (
    <div className="migration-banner format-banner" data-testid="vault-format-banner" role="status">
      <span className="migration-banner-text">{show === 'running' ? FORMAT_RUNNING : FORMAT_DONE}</span>
      {show === 'done' && (
        <button type="button" data-testid="vault-format-dismiss" onClick={() => setShow(null)}>
          Dismiss
        </button>
      )}
    </div>
  )
}

/** §15 N10: encryption was started but never finished; the notes are still the plaintext ones. */
function UnfinishedEncryption() {
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
          className="migration-banner-form"
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
