import { writeFile } from 'node:fs/promises'
import type { SecretBytes } from '../shared/secret'
import { destroyKey } from './vault/native'
import { decodeRecovery } from './vault/recovery'

/** What the saved file says around the key itself. */
const PREAMBLE = 'Slate recovery key\n\n'
const EPILOGUE = [
  '',
  '',
  'With this key you can open your encrypted Slate notes if you forget your password.',
  'Keep it somewhere safe and away from this computer. Anyone who has it and a copy of your',
  'notes can read them.',
  '',
].join('\n')

/**
 * The saved file's bytes, with the key spliced between the two fixed parts. The caller zeroes the result.
 *
 * Assembled as bytes rather than built as a string, and `key` is the bytes main already holds: a string of
 * the key here could not be zeroed and would outlive the lock in V8's heap (POAM-10, T-ZERO-09). The module
 * decodes the key first, so only a well-formed one is ever written, and the handle is destroyed at once.
 */
function recoveryFileBytes(key: SecretBytes): SecretBytes {
  destroyKey(decodeRecovery(key))
  const head = new TextEncoder().encode(PREAMBLE)
  const tail = new TextEncoder().encode(EPILOGUE)
  const out = new Uint8Array(head.length + key.length + tail.length)
  out.set(head, 0)
  // Byte by byte, as `moduleCopy` does: handing the key to `set` would hand a secret to an
  // `ArrayLike<number>` parameter, which loses the brand (slate/secret-bytes-stay-bytes).
  for (let i = 0; i < key.length; i++) out[head.length + i] = key[i] ?? 0
  out.set(tail, head.length + key.length)
  return out
}

/**
 * Writes the recovery key to `path`, owner-read-only, and zeroes every copy it made.
 *
 * The write lives here, with the assembly, because this is the one place a vault secret is meant to
 * reach a file: the person asked Slate to save their recovery key. `slate/secret-bytes-stay-bytes`
 * otherwise refuses a secret at a file sink, deliberately (a log stream must never take one), and the
 * code it used to push this flow towards -- turn the key into a string first -- is the defect
 * T-ZERO-09 measured on v0.7.0. So this file is a sanctioned home for the rule
 * (tools/eslint-rules/plugin.mjs). It sits outside `vault/` because the file is not a vault file -- the
 * person keeps it away from their notes (`refuseRecoveryPath`), so `vault-writes-through-atomic` does
 * not apply to it. `key` stays the caller's to zero.
 */
export async function writeRecoveryFile(path: string, key: SecretBytes): Promise<void> {
  const bytes = recoveryFileBytes(key)
  try {
    await writeFile(path, bytes, { mode: 0o600 })
  } finally {
    bytes.fill(0)
  }
}
