import { describe, expect, it } from 'vitest'
import { quickUnlockOfferText } from './quickUnlockText'

// U1 (e2e-ubuntu scenario 6): on Ubuntu the offer named Touch ID, which Linux does not have.
describe('the offer to set quick unlock up again', () => {
  it('names the system keyring on Linux and Touch ID on macOS', () => {
    expect(quickUnlockOfferText('keyring')).toBe('Unlock with the system keyring stopped working. Set it up again?')
    expect(quickUnlockOfferText('touchid')).toBe('Touch ID unlock stopped working. Set it up again?')
  })
})
