// PQ-A1: main reaches ML-DSA only through vault/native.ts, so main/update never imports @slate/native itself.
import { describe, expect, it } from 'vitest'
import { sigVerCases, spki } from '../../../../native/test/vectors/mldsa/sigver'
import { verifyMlDsa } from './native'

describe('verifyMlDsa (PQ-A1)', () => {
  it('verifies the ACVP ML-DSA-65 and ML-DSA-87 vectors through the module, and refuses a flipped bit', () => {
    for (const c of sigVerCases()) {
      expect(verifyMlDsa(c.level, spki(c.level, c.pk), c.message, c.context, c.signature), `tcId ${c.tcId}`).toBe(c.passed)
    }
    const c = sigVerCases()[0]!
    const sig = Uint8Array.from(c.signature)
    sig[0]! ^= 1
    expect(verifyMlDsa(c.level, spki(c.level, c.pk), c.message, c.context, sig)).toBe(false)
  })
})
