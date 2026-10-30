import { describe, expect, it } from 'vitest'
import { SPELLCHECK_UNAVAILABLE_HELP, spellcheckAvailable } from './spellcheck'

describe('spell check availability (shared with the renderer)', () => {
  it('is off on Linux, with the reason the Autocorrect section shows', () => {
    expect(spellcheckAvailable('linux')).toBe(false)
    expect(spellcheckAvailable('darwin')).toBe(true)
    expect(SPELLCHECK_UNAVAILABLE_HELP).toBe('Not available on Linux: it would download dictionaries from the internet.')
  })
})
