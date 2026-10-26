// Z-5 (audit §4.3, C7): a typed secret, a password or a recovery key, travels as the UTF-8 bytes of its NFC
// form, never as a string. Its owner zeroes the array once the call that needed it settles; the module
// wipes its own copy as it derives a key.

declare const secretBytesBrand: unique symbol
/**
 * The bytes of a typed secret. Each holder zeroes its array when done with it (`zeroSecret`). The optional
 * brand names the type for `slate/secret-bytes-stay-bytes` (no decode, no text) and costs callers nothing.
 */
export type SecretBytes = Uint8Array & { readonly [secretBytesBrand]?: true }

/** NFC, then UTF-8: the one encoding of a typed secret, the same as the vault's KDF input since v1. */
export function secretBytes(text: string): SecretBytes {
  return new TextEncoder().encode(text.normalize('NFC'))
}

export function zeroSecret(...secrets: Array<SecretBytes | null | undefined>): void {
  for (const s of secrets) s?.fill(0)
}

/** The limits main accepts at the IPC boundary: anything else is refused before it reaches a KDF. */
export const SECRET_MAX_BYTES = 4096

/** Main side of Z-5: the only accepted shape is a non-empty Uint8Array of at most 4096 bytes. */
export function passwordBytes(arg: unknown): SecretBytes | null {
  return arg instanceof Uint8Array && arg.length >= 1 && arg.length <= SECRET_MAX_BYTES ? arg : null
}

/** Every typed secret among an invoke's arguments: a Uint8Array, or the `password`/`recoveryKey` of an object. */
export function secretsIn(args: readonly unknown[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const a of args) {
    if (a instanceof Uint8Array) out.push(a)
    else if (typeof a === 'object' && a !== null) {
      const o = a as Record<string, unknown>
      if (o.password instanceof Uint8Array) out.push(o.password)
      if (o.recoveryKey instanceof Uint8Array) out.push(o.recoveryKey)
    }
  }
  return out
}
