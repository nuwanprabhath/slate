// Z-5 (audit §4.3, listing B.19): a typed secret is read from its field once, at submit, and never kept in
// React state. The field is cleared, the bytes go to main, and the page zeroes them when the call settles.
// The field's own string and the DOM cannot be zeroed (Z-11); the lock screen's renderer process exits
// after unlock (Z-6), and the other fields are cleared as soon as they are read.
import { secretBytes, zeroSecret, type SecretBytes } from '../../../shared/secret'

/** A secret field: an <input> or <textarea>, or a stand-in in a test. */
export interface SecretSource {
  value: string
}

/** The field's secret as bytes, and the field cleared. Null for an empty or missing field. */
export function takeSecret(field: SecretSource | null | undefined): SecretBytes | null {
  if (!field || field.value === '') return null
  const bytes = secretBytes(field.value)
  field.value = ''
  return bytes
}

/** The field's secret as bytes, the field left as it is (the strength hint while a new password is typed). */
export function peekSecret(field: SecretSource | null | undefined): SecretBytes | null {
  return field && field.value !== '' ? secretBytes(field.value) : null
}

/** Runs `send` with secrets the caller just took, and zeroes them when it settles, however it settles. */
export async function sendSecrets<T>(secrets: Array<SecretBytes | null>, send: () => Promise<T>): Promise<T> {
  try {
    return await send()
  } finally {
    zeroSecret(...secrets)
  }
}

/** Reads the field once, clears it, sends the bytes, zeroes them (B.19 `submitPassword`). Null for an empty field. */
export async function submitSecret<T>(field: SecretSource | null | undefined, send: (secret: SecretBytes) => Promise<T>): Promise<T | null> {
  const secret = takeSecret(field)
  return secret ? sendSecrets([secret], () => send(secret)) : null
}
