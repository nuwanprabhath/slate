// Criterion 5 (audit §7.3 C6): the error screen's text is S-6's, word for word.
import { describe, expect, it } from 'vitest'
import { SELF_TEST_FAILED_TEXT, selfTestFailedCode, selfTestFailedSentence } from './selfTestText'

describe('the self-test error screen (S-6)', () => {
  it("says exactly the audit's sentence, with the first failed check's id", () => {
    expect(selfTestFailedSentence('POST-AES-GCM-ENC')).toBe(
      'Slate stopped: a cryptographic self-test failed (POST-AES-GCM-ENC). Your notes were not opened. Quit and start Slate again; if this repeats, reinstall Slate.',
    )
    expect([SELF_TEST_FAILED_TEXT.quit, SELF_TEST_FAILED_TEXT.copy]).toEqual(['Quit', 'Copy diagnostic report'])
  })

  it('reads the id from the page query, and shows nothing but a POST id', () => {
    expect(selfTestFailedCode('?selftest-failed=POST-ZEROIZE')).toBe('POST-ZEROIZE')
    expect(selfTestFailedCode('?lock=1')).toBeNull()
    expect(selfTestFailedCode('')).toBeNull()
    expect(selfTestFailedCode('?selftest-failed=%3Cimg%20src%3Dx%3E')).toBe('POST-UNKNOWN')
    expect(selfTestFailedCode('?selftest-failed=')).toBe('POST-UNKNOWN')
  })
})
