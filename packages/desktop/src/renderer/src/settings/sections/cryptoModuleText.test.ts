import { describe, expect, it } from 'vitest'
import type { CryptoModuleStatus } from '../../../../shared/api'
import { cryptoModuleRows } from './cryptoModuleText'

const healthy: CryptoModuleStatus = {
  available: true,
  problem: null,
  module: 'OpenSSL FIPS Provider',
  version: '3.1.2',
  cmvp: 4985,
  standard: 'FIPS 140-3',
  certificateUrl: 'https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4985',
  approvedMode: true,
  errorState: false,
  postMs: 42,
  libcrypto: 'OpenSSL 3.5.9 30 Sep 2026',
  secureHeapLocked: true,
  development: false,
}

describe('cryptoModuleRows (Settings → Security, F-FIPS-08)', () => {
  it('shows module name, version, CMVP number, approved-mode state and POST time', () => {
    expect(cryptoModuleRows(healthy)).toEqual([
      ['Module', 'OpenSSL FIPS Provider 3.1.2'],
      ['Validation', 'FIPS 140-3, CMVP certificate #4985'],
      ['Approved mode', 'On'],
      ['Self-test at launch', 'Passed in 42 ms'],
      ['Library', 'OpenSSL 3.5.9 30 Sep 2026'],
    ])
  })

  it('a development build without the provider never says the self-test passed (review M2)', () => {
    const rows = cryptoModuleRows({ ...healthy, approvedMode: false, development: true })
    expect(rows).toContainEqual(['Approved mode', 'Off: development build without the FIPS provider'])
    expect(rows).toContainEqual(['Self-test at launch', 'Not run: no FIPS provider'])
    expect(rows.some(([, v]) => v.startsWith('Passed'))).toBe(false)
  })

  it('never says Passed when approved mode is off, whatever else the status says', () => {
    for (const s of [{ ...healthy, approvedMode: false }, { ...healthy, approvedMode: false, development: true }, { ...healthy, approvedMode: false, problem: 'X' }]) {
      expect(cryptoModuleRows(s).some(([, v]) => v.startsWith('Passed'))).toBe(false)
    }
  })

  it('says when the module failed its self-test, with the code', () => {
    const rows = cryptoModuleRows({ ...healthy, approvedMode: false, errorState: true, problem: 'POST-MODULE-LOAD (SCC_6)' })
    expect(rows).toContainEqual(['Approved mode', 'Off'])
    expect(rows).toContainEqual(['Self-test at launch', 'Failed: POST-MODULE-LOAD (SCC_6)'])
  })

  it('says when memory locking is unavailable (Z-10)', () => {
    expect(cryptoModuleRows({ ...healthy, secureHeapLocked: false })).toContainEqual(['Memory locking', 'Memory locking is unavailable on this system'])
  })

  it('reports a missing module as not available', () => {
    const rows = cryptoModuleRows({ ...healthy, available: false, approvedMode: false, postMs: null, libcrypto: null, secureHeapLocked: null, problem: 'The cryptographic module is not available in this build.' })
    expect(rows).toEqual([
      ['Module', 'Not available'],
      ['Validation', 'FIPS 140-3, CMVP certificate #4985'],
      ['Approved mode', 'Off'],
    ])
  })
})
