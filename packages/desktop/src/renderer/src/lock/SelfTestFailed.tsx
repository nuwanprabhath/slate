import { useState } from 'react'
import iconUrl from '../../../../resources/icon.png'
import { SELF_TEST_FAILED_TEXT } from './selfTestText'
import './lock.css'

/**
 * The only screen after a failed power-up or later self-test (audit §4.2 S-6, S-9): no way back into the notes,
 * no retry. It calls no vault channel: the failed check comes in the page query, and its two buttons are the
 * two channels main serves in this state besides status and window chrome.
 */
export function SelfTestFailed({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void window.slate.diagnostics
      .copyReport()
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }
  return (
    <div className="lock-screen" data-testid="selftest-failed">
      <div className="lock-card selftest-card" role="alertdialog" aria-labelledby="selftest-failed-title" aria-describedby="selftest-failed-text">
        <img className="lock-icon" src={iconUrl} alt="" width={64} height={64} />
        <h1 className="lock-title" id="selftest-failed-title">
          Slate stopped
        </h1>
        <p className="selftest-text" id="selftest-failed-text">
          {SELF_TEST_FAILED_TEXT.before}
          <code data-testid="selftest-failed-code">{code}</code>
          {SELF_TEST_FAILED_TEXT.after}
        </p>
        <button type="button" className="lock-unlock" data-testid="selftest-quit" autoFocus onClick={() => void window.slate.quit()}>
          {SELF_TEST_FAILED_TEXT.quit}
        </button>
        <button type="button" className="lock-link" data-testid="selftest-copy-report" onClick={copy}>
          {copied ? SELF_TEST_FAILED_TEXT.copied : SELF_TEST_FAILED_TEXT.copy}
        </button>
      </div>
    </div>
  )
}
