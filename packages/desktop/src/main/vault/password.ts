// Bundled so the check needs no file next to the built main bundle.
import commonList from './common-passwords.txt?raw'
import { PROFILES, type ProfileId } from './profile'

import type { SecretBytes } from '../../shared/secret'

let common: Set<string> | null = null
function commonPasswords(): Set<string> {
  common ??= new Set(commonList.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean))
  return common
}

/** A length/class hint, not a guarantee: 0 = refused or trivial, 4 = long and varied. */
function strengthOf(pw: string): 0 | 1 | 2 | 3 | 4 {
  const len = [...pw].length
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  const distinct = new Set(pw).size
  if (distinct <= 3) return 0
  let score = len >= 20 ? 3 : len >= 14 ? 2 : 1
  if (classes >= 3) score++
  return Math.min(score, 4) as 1 | 2 | 3 | 4
}

/**
 * §3 and audit §4.1: NFC, at least the profile's minimum (10 characters; 15 for fips-140-3, SP 800-63B-4), not a
 * common password whatever its length, not the user's own name or email.
 *
 * Residual (audit §4.3 Z-11, C7 criterion 5): the one place a typed secret becomes a string in this process.
 * The policy needs text (characters, case folding, the common-password list), so a password being *set*
 * (the wizard, a change, its strength hint) is decoded here; V8 strings cannot be zeroed. Unlock never
 * calls this: there the password goes from IPC to the KDF as bytes only. `pw` stays its owner's to zero.
 */
export function checkPassword(pw: SecretBytes, context: string[], profile: ProfileId = 'standard'): { ok: boolean; reason?: string; strength: 0 | 1 | 2 | 3 | 4 } {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(pw)
  } catch {
    return { ok: false, reason: 'That password is not valid text.', strength: 0 }
  }
  const nfc = text.normalize(PROFILES[profile].password.normalization)
  const lower = nfc.toLowerCase()
  const min = PROFILES[profile].password.minLength
  if ([...nfc].length < min) return { ok: false, reason: `Use at least ${min} characters.`, strength: 0 }
  if (commonPasswords().has(lower)) return { ok: false, reason: 'That is one of the most common passwords.', strength: 0 }
  if (context.some((c) => c.normalize('NFC').toLowerCase() === lower)) {
    return { ok: false, reason: 'Do not use your name, email or notebook name.', strength: 0 }
  }
  return { ok: true, strength: strengthOf(nfc) }
}
