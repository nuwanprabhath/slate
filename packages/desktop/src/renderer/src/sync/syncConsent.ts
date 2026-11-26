import { consentRequiredFeature, type ConsentFeature } from '../../../shared/privacy/consent'
import { askConsent } from '../privacy/askConsent'
import { openEncryptWizard } from '../vault/events'

/** What the plaintext consent step offers first instead (GDPR-03). */
export const ENCRYPT_FIRST = 'Encrypt my notes first'

/** main's `PlaintextSyncRefused` (syncService.ts), read back from an invoke rejection. */
export const plaintextRefused = (e: unknown): boolean => e instanceof Error && /\bPlaintextSyncRefused\b/.test(`${e.name}: ${e.message}`)

/** The consent a sync refusal asks for; null for any other error. */
export const refusedFeature = (e: unknown): ConsentFeature | null => consentRequiredFeature(e) ?? (plaintextRefused(e) ? 'plaintextSync' : null)

/**
 * One consent step. Unencrypted sync offers encrypting first as its main action, which runs `beforeEncrypt`
 * (closing whatever is open) and opens the wizard. True once granted.
 */
export async function askSyncConsent(feature: ConsentFeature, beforeEncrypt: () => void = () => {}): Promise<boolean> {
  if (feature !== 'plaintextSync') return (await askConsent(feature)) === 'granted'
  const answer = await askConsent(feature, {
    label: ENCRYPT_FIRST,
    onClick: () => {
      beforeEncrypt()
      openEncryptWizard()
    },
  })
  return answer === 'granted'
}

/**
 * Runs `task`; each consent refusal from main becomes one consent step and a retry. False when the person
 * did not allow a step (sync stays off); any other error is thrown.
 */
export async function withSyncConsent(task: () => Promise<unknown>, beforeEncrypt?: () => void): Promise<boolean> {
  for (let tries = 0; ; tries++) {
    try {
      await task()
      return true
    } catch (e) {
      const feature = refusedFeature(e)
      if (!feature || tries >= 3) throw e
      if (!(await askSyncConsent(feature, beforeEncrypt))) return false
    }
  }
}
