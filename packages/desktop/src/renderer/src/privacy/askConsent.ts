import type { ConsentFeature } from '../../../shared/privacy/consent'

/** What a consent step offers instead of Allow, as the main action ("Encrypt my notes first"). */
export interface ConsentAlternative {
  label: string
  onClick(): void
}

/** The answer: granted (main recorded it), declined, or the person took the alternative instead. */
export type ConsentAnswer = 'granted' | 'declined' | 'alternative'

export interface ConsentRequest {
  feature: ConsentFeature
  primaryAlternative?: ConsentAlternative
  resolve(answer: ConsentAnswer): void
}

const ASK = 'slate:consent'

/**
 * Shows the ConsentDialog for `feature` (the one ConsentHost in main.tsx draws it) and resolves with the answer.
 * A section that got a `ConsentRequired` error (`consentRequiredFeature`) asks here, then retries on 'granted'.
 */
export function askConsent(feature: ConsentFeature, primaryAlternative?: ConsentAlternative): Promise<ConsentAnswer> {
  return new Promise((resolve) => {
    const detail: ConsentRequest = { feature, resolve, ...(primaryAlternative ? { primaryAlternative } : {}) }
    window.dispatchEvent(new CustomEvent<ConsentRequest>(ASK, { detail }))
  })
}

export function onConsentRequest(handler: (request: ConsentRequest) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<ConsentRequest>).detail)
  window.addEventListener(ASK, listener)
  return () => window.removeEventListener(ASK, listener)
}
