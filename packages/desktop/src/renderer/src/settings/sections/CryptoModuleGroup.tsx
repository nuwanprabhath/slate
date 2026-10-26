import { useEffect, useState } from 'react'
import type { CryptoModuleStatus, SelfTestSummary } from '../../../../shared/api'
import { cryptoModuleRows } from './cryptoModuleText'
import { ExternalLink } from '../../ExternalLink'

/** Settings → Security: which cryptographic module Slate runs on and whether it is in approved mode (F-FIPS-08). */
export function CryptoModuleGroup() {
  const [status, setStatus] = useState<CryptoModuleStatus | null>(null)
  const [selfTest, setSelfTest] = useState<SelfTestSummary | 'running' | null>(null)
  useEffect(() => {
    void window.slate.vault
      .moduleStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])
  // Audit S-7 (a): the whole power-up self-test on demand. A failure stops Slate (this window is replaced by the
  // error screen), so a result shown here is a pass.
  const runSelfTest = () => {
    setSelfTest('running')
    void window.slate.vault
      .selfTest()
      .then(setSelfTest)
      .catch(() => setSelfTest(null))
  }
  if (!status) return null
  return (
    <fieldset className="settings-group" data-testid="security-module">
      <legend>Cryptographic module</legend>
      <dl className="security-module">
        {cryptoModuleRows(status).map(([label, value]) => (
          <div key={label} data-testid={`security-module-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="settings-row">
        <button type="button" data-testid="security-run-selftest" disabled={selfTest === 'running'} onClick={runSelfTest}>
          {selfTest === 'running' ? 'Running self-tests…' : 'Run self-tests'}
        </button>
        {selfTest !== null && selfTest !== 'running' && (
          <span data-testid="security-selftest-result">{selfTest.passed ? `Passed (${String(selfTest.ms ?? 0)} ms)` : `Failed: ${selfTest.failed.join(', ')}`}</span>
        )}
      </div>
      <ExternalLink className="lock-link" href={status.certificateUrl}>
        View the CMVP certificate
      </ExternalLink>
    </fieldset>
  )
}
