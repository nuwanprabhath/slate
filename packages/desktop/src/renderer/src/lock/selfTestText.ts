// The self-test error screen's words (audit §4.2 S-6), kept apart so a test pins them.

/** What the screen says, around the failed check's id (shown in its own element). */
export const SELF_TEST_FAILED_TEXT = {
  before: 'Slate stopped: a cryptographic self-test failed (',
  after: '). Your notes were not opened. Quit and start Slate again; if this repeats, reinstall Slate.',
  quit: 'Quit',
  copy: 'Copy diagnostic report',
  copied: 'Copied',
} as const

/** The id from `?selftest-failed=<id>`, or null when this page is not the error screen. Only POST ids are shown. */
export function selfTestFailedCode(search: string): string | null {
  const raw = new URLSearchParams(search).get('selftest-failed')
  if (raw === null) return null
  return /^POST-[A-Z0-9-]{2,40}$/.test(raw) ? raw : 'POST-UNKNOWN'
}

/** The whole sentence, as a screen reader or a copy of the page reads it. */
export function selfTestFailedSentence(code: string): string {
  return `${SELF_TEST_FAILED_TEXT.before}${code}${SELF_TEST_FAILED_TEXT.after}`
}
