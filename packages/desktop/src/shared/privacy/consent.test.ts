import { describe, expect, it } from 'vitest'
import { CONSENT_FEATURES, DISCLOSURES, egressAllowed, isConsentFeature, sanitizeConsents, type ConsentRecord, type Consents } from './consent'

const current = (f: (typeof CONSENT_FEATURES)[number], source: ConsentRecord['source'] = 'user'): ConsentRecord => ({ grantedAt: 1, textVersion: DISCLOSURES[f].textVersion, source })

describe('consent features and disclosures', () => {
  it('has a disclosure for every feature, naming hosts only, at least one data type and a recipient', () => {
    for (const f of CONSENT_FEATURES) {
      const d = DISCLOSURES[f]
      expect(d.title.length, f).toBeGreaterThan(0)
      expect(d.data.length, f).toBeGreaterThan(0)
      expect(d.recipient.length, f).toBeGreaterThan(0)
      expect(Number.isInteger(d.textVersion) && d.textVersion >= 1, f).toBe(true)
      for (const host of d.endpoints) expect(host, f).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
    }
    expect(Object.keys(DISCLOSURES).sort()).toEqual([...CONSENT_FEATURES].sort())
  })

  it('names the update hosts and GitHub as the recipient', () => {
    expect(DISCLOSURES.updates.endpoints).toEqual(['github.com', 'objects.githubusercontent.com'])
    expect(DISCLOSURES.updates.recipient).toBe('GitHub, Inc. (USA)')
    expect(DISCLOSURES.claudeTheme.recipient).toMatch(/Anthropic/)
  })

  it('isConsentFeature accepts exactly the listed features', () => {
    for (const f of CONSENT_FEATURES) expect(isConsentFeature(f)).toBe(true)
    for (const v of ['', 'Updates', 'toString', '__proto__', 1, null, undefined, {}, ['updates']]) expect(isConsentFeature(v)).toBe(false)
  })
})

describe('egressAllowed', () => {
  it('strict mode off: every feature is allowed, consents or not', () => {
    for (const f of CONSENT_FEATURES) expect(egressAllowed({ gdprStrictMode: false, consents: {} }, f)).toBe(true)
  })

  it('strict mode on: only a current grant counts', () => {
    const consents: Consents = { updates: current('updates') }
    expect(egressAllowed({ gdprStrictMode: true, consents }, 'updates')).toBe(true)
    expect(egressAllowed({ gdprStrictMode: true, consents }, 'gitSync')).toBe(false)
    expect(egressAllowed({ gdprStrictMode: true, consents: {} }, 'updates')).toBe(false)
  })

  it('a legacy grant counts like a user grant', () => {
    expect(egressAllowed({ gdprStrictMode: true, consents: { gitSync: current('gitSync', 'legacy') } }, 'gitSync')).toBe(true)
  })

  it('a grant for an older disclosure text no longer counts', () => {
    const stale: ConsentRecord = { grantedAt: 1, textVersion: DISCLOSURES.updates.textVersion - 1, source: 'user' }
    expect(egressAllowed({ gdprStrictMode: true, consents: { updates: stale } }, 'updates')).toBe(false)
  })
})

describe('sanitizeConsents', () => {
  it('keeps well-formed records of known features', () => {
    const consents = { updates: current('updates'), gitSync: current('gitSync', 'legacy') }
    expect(sanitizeConsents(consents)).toEqual(consents)
  })

  it('drops unknown features and malformed records, and refuses a non-object', () => {
    expect(
      sanitizeConsents({
        nope: current('updates'),
        updates: { grantedAt: Number.NaN, textVersion: 1, source: 'user' },
        gitSync: { grantedAt: 1, textVersion: 1.5, source: 'user' },
        oneDriveSync: { grantedAt: 1, textVersion: 1, source: 'renderer' },
        claudeTheme: { grantedAt: 1, textVersion: 1, source: 'user', extra: true },
        githubSignIn: 'yes',
      }),
    ).toEqual({ claudeTheme: { grantedAt: 1, textVersion: 1, source: 'user' } })
    for (const v of [null, [], 'x', 1, new Uint8Array(2)]) expect(sanitizeConsents(v)).toBeUndefined()
  })

  it('is idempotent and never keeps an inherited key', () => {
    const parsed = JSON.parse('{"__proto__": {"grantedAt": 1, "textVersion": 1, "source": "user"}, "updates": {"grantedAt": 2, "textVersion": 1, "source": "user"}}') as unknown
    const once = sanitizeConsents(parsed)
    expect(once).toEqual({ updates: { grantedAt: 2, textVersion: 1, source: 'user' } })
    expect(sanitizeConsents(once)).toEqual(once)
  })
})
