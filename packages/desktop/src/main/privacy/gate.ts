/**
 * The one place main asks whether a feature may send data off this computer (GDPR review §3.1 step 5).
 * Pure apart from its source, which index.ts sets to the open store's settings: while the notes are
 * closed (an encrypted vault locked) there are no settings to read, so nothing is allowed.
 */
import type { Settings } from '../../shared/api'
import { CONSENT_REQUIRED, egressAllowed, type ConsentFeature } from '../../shared/privacy/consent'

let source: () => Settings | null = () => null

/** index.ts: `() => openStore() ? readSettings(openStore()) : null`. */
export function setPrivacySource(fn: () => Settings | null): void {
  source = fn
}

/** Fails closed: no open store (or a store that closed under the read) means no consent. */
export function allowed(feature: ConsentFeature): boolean {
  let settings: Settings | null
  try {
    settings = source()
  } catch {
    return false
  }
  return settings !== null && egressAllowed(settings, feature)
}

/** How a gated call refuses: the renderer reads the feature back with `consentRequiredFeature` and shows the dialog. */
export class ConsentRequired extends Error {
  override name = CONSENT_REQUIRED
  constructor(readonly feature: ConsentFeature) {
    super(`${feature} needs consent`)
  }
}

export function requireConsent(feature: ConsentFeature): void {
  if (!allowed(feature)) throw new ConsentRequired(feature)
}
