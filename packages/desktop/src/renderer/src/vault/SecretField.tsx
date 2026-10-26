import type { Ref } from 'react'

/**
 * The renderer's one way to draw a field that takes a password or a recovery key (lint rule
 * `slate/secrets-out-of-react-state`). Uncontrolled: the typed text stays in the field and never reaches
 * React state; the submit handler reads it once with `takeSecret`/`submitSecret` (secretInput.ts), which
 * clears the field, and zeroes the bytes once main has them (Z-5, listing B.19). `onEdit` hands over the
 * field itself, so a caller can tell whether it is empty (or, for a new password, ask for a strength hint)
 * without copying the text.
 */
interface Common {
  'data-testid'?: string
  placeholder?: string
  'aria-label'?: string
  autoFocus?: boolean
  className?: string
  onEdit?: (field: HTMLInputElement | HTMLTextAreaElement) => void
}

export function SecretField({ fieldRef, kind = 'password', onEdit, ...rest }: Common & { fieldRef: Ref<HTMLInputElement>; kind?: 'password' | 'text' }) {
  return <input {...rest} ref={fieldRef} type={kind} autoComplete="off" spellCheck={false} onChange={(e) => onEdit?.(e.currentTarget)} />
}

export function SecretArea({ fieldRef, rows = 3, onEdit, ...rest }: Common & { fieldRef: Ref<HTMLTextAreaElement>; rows?: number }) {
  return <textarea {...rest} ref={fieldRef} rows={rows} autoComplete="off" spellCheck={false} onChange={(e) => onEdit?.(e.currentTarget)} />
}
