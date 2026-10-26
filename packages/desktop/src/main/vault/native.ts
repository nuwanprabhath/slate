// The vault's one way to cryptography: every primitive runs inside @slate/native, and JavaScript holds
// key handles, never key bytes (audit C4, §4.0 invariants 1 and 2). The module is the one the notes
// database runs on (db/dbModule.ts): launch.ts starts it, the main-process tests register their own.
import type { KeyHandle, SlateNative } from '@slate/native'
import { dbModule } from '../db/dbModule'

export function vaultNative(): SlateNative {
  return dbModule().native
}

/** Destroys `key` if it is still live. A handle already gone (destroyed by its owner, or by zeroizeAll) is not an error. */
export function destroyKey(key: KeyHandle | null | undefined): void {
  if (key === null || key === undefined) return
  try {
    vaultNative().keyDestroy(key)
  } catch {
    // SCC_8: nothing left to destroy.
  }
}

/** Constant-time equality for MACs and checks (their length is public). */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Strict base64 of public bytes (nonces, ciphertexts, MACs). */
export const toBase64 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')
export const toHex = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex')
