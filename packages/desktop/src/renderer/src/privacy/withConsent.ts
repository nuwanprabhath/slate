import { consentRequiredFeature, type ConsentFeature } from '../../../shared/privacy/consent'
import { askConsent } from './askConsent'

/**
 * Runs `run` for a feature that sends data off this computer: asks first when `egressAllowed` is false
 * (`privacy.status().allowed`; `askFirst: false` skips that, for an action main always allows), and when main still refuses with `ConsentRequired` (a grant it no longer
 * counts, or a gate the status did not predict) asks once more and retries. `null` means the person said no.
 */
export async function withConsent<T>(feature: ConsentFeature, run: () => Promise<T>, options: { askFirst?: boolean } = {}): Promise<{ value: T } | null> {
  if (options.askFirst !== false) {
    const status = await window.slate.privacy.status()
    if (!status.allowed[feature] && (await askConsent(feature)) !== 'granted') return null
  }
  try {
    return { value: await run() }
  } catch (e) {
    const needed = consentRequiredFeature(e)
    if (needed === null) throw e
    if ((await askConsent(needed)) !== 'granted') return null
    return { value: await run() }
  }
}
