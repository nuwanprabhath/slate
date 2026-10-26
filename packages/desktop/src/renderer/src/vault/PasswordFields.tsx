import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import type { PasswordCheck, VaultProfile } from '../../../shared/api'
import type { SecretBytes } from '../../../shared/secret'
import { SecretField } from './SecretField'
import { peekSecret, sendSecrets, takeSecret } from './secretInput'

const STRENGTH = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong']

/** What the parent does with the new password: take it once, at submit. */
export interface NewPasswordHandle {
  /** The new password as bytes, both fields cleared; the caller zeroes the bytes when its call settles. */
  take(): SecretBytes | null
}

/**
 * A new password typed twice, with main's strength hint (§3: minimum 10, common passwords refused; 15 for the
 * fips-140-3 profile, and without `profile` main checks against the vault's own). The text
 * stays in the two fields, never in React state (Z-5): the hint is asked for with bytes zeroed once main has
 * answered, and the parent reads the password through `control` at submit.
 */
export function PasswordFields({
  control,
  onValid,
  testId = 'wizard-password',
  profile,
}: {
  control: RefObject<NewPasswordHandle | null>
  onValid: (ok: boolean) => void
  testId?: string
  profile?: VaultProfile
}) {
  const first = useRef<HTMLInputElement>(null)
  const again = useRef<HTMLInputElement>(null)
  const asked = useRef(0)
  const [check, setCheck] = useState<PasswordCheck | null>(null)
  const [same, setSame] = useState(true)
  const [againTyped, setAgainTyped] = useState(false)

  const compare = () => {
    setSame(first.current?.value === again.current?.value)
    setAgainTyped((again.current?.value ?? '') !== '')
  }
  const firstEdited = () => {
    compare()
    const id = ++asked.current
    const bytes = peekSecret(first.current)
    if (!bytes) return setCheck(null)
    void sendSecrets([bytes], () => window.slate.vault.checkPassword(bytes, profile))
      .then((c) => id === asked.current && setCheck(c))
      .catch(() => {})
  }

  useImperativeHandle(control, () => ({
    take: () => {
      const bytes = takeSecret(first.current)
      if (again.current) again.current.value = ''
      asked.current++
      setCheck(null)
      setSame(true)
      setAgainTyped(false)
      return bytes
    },
  }))

  const ok = check?.ok === true && same
  useEffect(() => onValid(ok), [ok, onValid])

  return (
    <>
      <SecretField fieldRef={first} data-testid={testId} placeholder="New password" autoFocus onEdit={firstEdited} />
      <SecretField fieldRef={again} data-testid={`${testId}-again`} placeholder="The same password again" onEdit={compare} />
      <span className="vault-hint" data-testid={`${testId}-strength`}>
        {check === null ? 'At least 10 characters. A few unrelated words make a strong one.' : check.ok ? `Strength: ${STRENGTH[check.strength]}` : check.reason}
        {check?.ok && againTyped && !same ? ' · The two passwords differ.' : ''}
      </span>
    </>
  )
}
