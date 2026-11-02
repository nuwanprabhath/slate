import { useRef } from 'react'
import { SecretField } from '../vault/SecretField'
import { submitSecret } from '../vault/secretInput'

/**
 * The password sudo asked for, typed into the banner: Slate may be started where no polkit agent
 * runs. Like every typed secret it is read from the field once, at submit, as bytes (`submitSecret`);
 * it never reaches React state, so a refused password comes back to an empty field.
 */
export function UpdatePasswordForm({ kind }: { kind: 'dmg' | 'deb' }) {
  const field = useRef<HTMLInputElement | null>(null)
  const u = window.slate.update
  const send = () => {
    void submitSecret(field.current, (secret) => u.installAndRestart(secret)).finally(() => field.current?.focus())
  }
  return (
    <form
      className="update-password"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <SecretField
        fieldRef={field}
        autoFocus
        className="update-password-input"
        data-testid="update-password"
        aria-label={kind === 'dmg' ? 'Your password for this Mac' : 'Your password for sudo'}
        placeholder={kind === 'dmg' ? 'Your Mac password' : 'Your sudo password'}
      />
      <button type="submit" data-testid="update-password-submit">
        Install
      </button>
      <button type="button" data-testid="update-password-cancel" onClick={() => void u.dismiss()}>
        Cancel
      </button>
    </form>
  )
}
