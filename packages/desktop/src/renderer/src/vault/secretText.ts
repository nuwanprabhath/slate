import type { SecretBytes } from '../../../shared/secret'
import { zeroSecret } from '../../../shared/secret'

/**
 * A secret main sent as bytes, as text for this window to show, zeroing the bytes it arrived in.
 *
 * A displayed recovery key has to become a string somewhere, and the renderer is where that is already
 * accepted: this window's process exits after unlock, so its strings go with it (audit Z-6, Z-11;
 * `docs/compliance/poam.md` POAM-10). In main the same string could not be zeroed and would outlive a
 * lock in V8's heap, which is what T-ZERO-09 measured on v0.7.0, so main keeps the key as bytes and
 * hands those over. This file is the one sanctioned home for the conversion
 * (`slate/secret-bytes-stay-bytes` in tools/eslint-rules/plugin.mjs), and it is in the renderer so that
 * `main-never-imports-renderer` (.dependency-cruiser.cjs) stops main reaching it.
 */
export function secretText(bytes: SecretBytes): string {
  try {
    return new TextDecoder().decode(bytes)
  } finally {
    zeroSecret(bytes)
  }
}
