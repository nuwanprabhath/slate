import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../../shared/api'
import { consentRequiredFeature, DISCLOSURES } from '../../shared/privacy/consent'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import { allowed, ConsentRequired, requireConsent, setPrivacySource } from './gate'

const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch })
const granted = { updates: { grantedAt: 1, textVersion: DISCLOSURES.updates.textVersion, source: 'user' as const } }

afterEach(() => setPrivacySource(() => null))

describe('privacy gate', () => {
  it('fails closed: with no source, or no open store, nothing is allowed, strict mode or not', () => {
    expect(allowed('updates')).toBe(false)
    setPrivacySource(() => null)
    expect(allowed('updates')).toBe(false)
    expect(() => requireConsent('gitSync')).toThrow(ConsentRequired)
  })

  it('strict mode: only a current grant; strict mode off: everything', () => {
    setPrivacySource(() => settings({ gdprStrictMode: true, consents: granted }))
    expect(allowed('updates')).toBe(true)
    expect(allowed('claudeTheme')).toBe(false)
    setPrivacySource(() => settings({ gdprStrictMode: false, consents: {} }))
    expect(allowed('claudeTheme')).toBe(true)
  })

  it('reads the source at every call, so a revoke counts at once', () => {
    let current = settings({ consents: granted })
    setPrivacySource(() => current)
    expect(allowed('updates')).toBe(true)
    current = settings({ consents: {} })
    expect(allowed('updates')).toBe(false)
  })

  it('a source that throws (the store closed under it) is no consent', () => {
    setPrivacySource(() => {
      throw new Error('Locked')
    })
    expect(allowed('updates')).toBe(false)
  })

  it('ConsentRequired names the feature, and the renderer can read it back from an IPC error', () => {
    setPrivacySource(() => settings({ consents: {} }))
    let caught: unknown
    try {
      requireConsent('claudeTheme')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConsentRequired)
    const e = caught as ConsentRequired
    expect(e.name).toBe('ConsentRequired')
    expect(e.feature).toBe('claudeTheme')
    // What ipcRenderer.invoke rejects with: Electron puts `${name}: ${message}` after its own prefix.
    expect(consentRequiredFeature(new Error(`Error invoking remote method 'themes:generate': ${e.name}: ${e.message}`))).toBe('claudeTheme')
    expect(consentRequiredFeature(e)).toBe('claudeTheme')
    expect(consentRequiredFeature(new Error('ConsentRequired: nope needs consent'))).toBeNull()
    expect(consentRequiredFeature('x')).toBeNull()
    expect(() => {
      setPrivacySource(() => settings({ consents: granted }))
      requireConsent('updates')
    }).not.toThrow()
  })
})
